/**
 * audit 2026-10-08 W3-6 (plumbing F8): the web-search adaptive hedge's miss
 * window is shared across processes through Redis (fail-open to the local one).
 */
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('axios', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
jest.mock('./brightdata-direct', () => ({
  ...jest.requireActual('./brightdata-direct'),
  tryDirectBrightData: jest.fn(),
  directBrightDataAvailable: () => true,
}));
jest.mock('./pdf-extract', () => ({ extractPdfText: jest.fn() }));
jest.mock('./platform/loop-metrics.service', () => ({
  __esModule: true,
  recordLoopMetric: jest.fn(),
  LOOP_METRIC_KINDS: { WEB_FETCH_PATH: 'web_fetch_path' },
}));

import {
  adaptiveHedgePlan, noteDirectOutcome, sharedDirectWindow, refreshSharedDirectWindow,
  __setSharedWindowRedisForTest, __resetDirectOutcomeWindowForTest, SHARED_WINDOW_KEY, WEB_HEDGE_DEFAULT_MS,
} from './mcp-search';

/** An in-memory node-redis double for the list ops the shared window uses. */
function fakeRedis() {
  const lists = new Map<string, string[]>();
  return {
    lists,
    lPush: jest.fn(async (k: string, v: string) => { const l = lists.get(k) ?? []; l.unshift(v); lists.set(k, l); return l.length; }),
    lTrim: jest.fn(async (k: string, start: number, stop: number) => { lists.set(k, (lists.get(k) ?? []).slice(start, stop + 1)); return 'OK'; }),
    expire: jest.fn(async () => 1),
    lRange: jest.fn(async (k: string, start: number, stop: number) => (lists.get(k) ?? []).slice(start, stop + 1)),
  };
}
const flush = () => new Promise((r) => setImmediate(r));

describe('shared adaptive hedge window (audit 2026-10-08 W3-6)', () => {
  beforeEach(() => {
    __resetDirectOutcomeWindowForTest();
    delete process.env.WEB_DIRECT_ADAPTIVE_SHARED_DISABLED;
  });
  afterEach(() => __setSharedWindowRedisForTest(undefined));

  it('REPLAY: this process holds 12 outcomes (below MIN_SAMPLES 20 — never adaptive pre-fix); the fleet window holds 40 at a 45 % miss rate ⇒ adaptive', async () => {
    const r = fakeRedis();
    __setSharedWindowRedisForTest(r);
    // the other processes' outcomes already in the shared list (newest first): 18 misses of 40 = 45 %
    r.lists.set(SHARED_WINDOW_KEY('search_engine'), Array.from({ length: 40 }, (_, i) => (i < 18 ? '1' : '0')));
    for (let i = 0; i < 12; i++) noteDirectOutcome('search_engine', i % 2 === 0); // 50 % locally, n = 12
    await flush();
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS)).toMatchObject({ adaptive: false, n: 12 }); // the pre-fix plan
    await refreshSharedDirectWindow('search_engine');
    const shared = sharedDirectWindow('search_engine');
    // this process's 12 pushes (6 misses) sit on top; the window keeps the newest 40: 6 + 18 misses = 60 %
    expect(shared).toEqual({ rate: 0.6, n: 40 });
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS, shared)).toEqual({ hedgeMs: 0, adaptive: true, missRate: 0.6, n: 40, windowSource: 'shared' });
    expect(r.lPush).toHaveBeenCalledWith(SHARED_WINDOW_KEY('search_engine'), '1');
    expect(r.lTrim).toHaveBeenCalledWith(SHARED_WINDOW_KEY('search_engine'), 0, 39);
  });

  it('the local window wins when it holds more samples; scrape never shares', async () => {
    const r = fakeRedis();
    __setSharedWindowRedisForTest(r);
    r.lists.set(SHARED_WINDOW_KEY('search_engine'), ['1', '1', '1']);
    await refreshSharedDirectWindow('search_engine');
    for (let i = 0; i < 25; i++) noteDirectOutcome('search_engine', false);
    expect(adaptiveHedgePlan('search_engine', WEB_HEDGE_DEFAULT_MS, { rate: 1, n: 3 })).toMatchObject({ adaptive: false, n: 25, windowSource: 'local' });
    noteDirectOutcome('scrape_as_markdown', true);
    await flush();
    expect(r.lists.has(SHARED_WINDOW_KEY('scrape_as_markdown'))).toBe(false);
    expect(sharedDirectWindow('scrape_as_markdown')).toBeNull();
  });

  it('fail-open: no client / a throwing client ⇒ no shared window, the local plan unchanged', async () => {
    __setSharedWindowRedisForTest(null);
    noteDirectOutcome('search_engine', true);
    expect(sharedDirectWindow('search_engine')).toBeNull();
    const broken = { lPush: jest.fn(async () => { throw new Error('ECONNRESET'); }), lTrim: jest.fn(), expire: jest.fn(), lRange: jest.fn(async () => { throw new Error('ECONNRESET'); }) };
    __setSharedWindowRedisForTest(broken);
    noteDirectOutcome('search_engine', true);
    await flush();
    await refreshSharedDirectWindow('search_engine');
    expect(sharedDirectWindow('search_engine')).toBeNull();
  });

  it('kill switch WEB_DIRECT_ADAPTIVE_SHARED_DISABLED=1: nothing pushed, nothing read', async () => {
    process.env.WEB_DIRECT_ADAPTIVE_SHARED_DISABLED = '1';
    const r = fakeRedis();
    __setSharedWindowRedisForTest(r);
    noteDirectOutcome('search_engine', true);
    await refreshSharedDirectWindow('search_engine');
    expect(r.lPush).not.toHaveBeenCalled();
    expect(r.lRange).not.toHaveBeenCalled();
    expect(sharedDirectWindow('search_engine')).toBeNull();
  });
});
