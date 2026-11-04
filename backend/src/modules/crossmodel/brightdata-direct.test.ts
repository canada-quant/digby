/**
 * Hardened web pipeline — the direct BrightData failover tier (2026-07-14).
 * Contract: same result shapes as the MCP tools; null (never throw) on failure;
 * only the three hot tools are covered.
 */

jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPost = jest.fn();
jest.mock('axios', () => ({ __esModule: true, default: { post: (...a: any[]) => mockPost(...a) } }));

describe('tryDirectBrightData', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });

  function load() {
    // re-require after env is set (module reads env at import)
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./brightdata-direct');
  }

  it('search_engine hits google with brd_json and returns the parsed SERP text', async () => {
    mockPost.mockResolvedValue({ data: '{"organic": [{"link":"https://x.com","title":"t"}]}' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('search_engine', { query: 'hello world', engine: 'google' });
    expect(out).toContain('"organic"');
    const [url, body] = mockPost.mock.calls[0];
    expect(url).toBe('https://api.brightdata.com/request');
    expect(body.url).toContain('google.com/search?q=hello%20world');
    expect(body.url).toContain('brd_json=1');
  });

  it('rejects a SERP response with no organic results (block/captcha page)', async () => {
    mockPost.mockResolvedValue({ data: '<html>unusual traffic</html>' });
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
  });

  it('scrape_as_markdown requests data_format markdown', async () => {
    mockPost.mockResolvedValue({ data: '# Page\ncontent' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com' });
    expect(out).toBe('# Page\ncontent');
    expect(mockPost.mock.calls[0][1].data_format).toBe('markdown');
  });

  it('scrape_batch fans out (≤5) and tolerates per-url failures', async () => {
    mockPost
      .mockResolvedValueOnce({ data: 'md-one' })
      .mockRejectedValueOnce(new Error('boom'));
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('scrape_batch', { urls: ['https://a.com', 'https://b.com'] });
    expect(out).toContain('md-one');
    expect(out).toContain('[scrape failed: boom]');
  });

  it('returns null for uncovered tools and when the token is absent', async () => {
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('browser_task', { task: 'x' })).toBeNull();
    delete process.env.BRIGHTDATA_API_TOKEN;
    jest.resetModules();
    const fresh = require('./brightdata-direct');
    expect(fresh.directBrightDataAvailable()).toBe(false);
    expect(await fresh.tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
  });

  it('never throws — provider errors become null', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('429'), { response: { status: 429 } }));
    const { tryDirectBrightData } = load();
    await expect(tryDirectBrightData('search_engine', { query: 'q' })).resolves.toBeNull();
  });

  it('scrape_as_markdown empty body → throws DirectEmptyBodyError (deterministic, #85)', async () => {
    mockPost.mockResolvedValue({ data: '   ' });
    const { tryDirectBrightData, DirectEmptyBodyError } = load();
    await expect(tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com/x.pdf' }))
      .rejects.toBeInstanceOf(DirectEmptyBodyError);
  });

  it('search_engine empty body → null (transient-safe contract unchanged, #85)', async () => {
    mockPost.mockResolvedValue({ data: '' });
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
  });

  it('scrape_batch keeps per-URL empty-body inline — no propagation (#85)', async () => {
    mockPost.mockResolvedValue({ data: '' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('scrape_batch', { urls: ['https://a.com'] });
    expect(out).toContain('[scrape failed: empty body from BrightData direct]');
  });

  it('empty 200 WITH x-brd-err-code → loud UPSTREAM warn, never the quiet empty-body path', async () => {
    mockPost.mockResolvedValue({
      data: '',
      status: 200,
      headers: { 'x-brd-err-code': 'client_10030', 'x-brd-err': '407 ip_forbidden' },
    });
    const { tryDirectBrightData } = load();
    const logger = require('../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    (logger.info as jest.Mock).mockClear();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('client_10030'), expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('UPSTREAM rejection'), expect.anything());
    expect(logger.info).not.toHaveBeenCalledWith(expect.stringContaining('no extractable content'));
  });

  it('scrape_as_markdown with x-brd-err-code → upstream warn + null (gateway fallback), no DirectEmptyBodyError', async () => {
    mockPost.mockResolvedValue({ data: '', status: 200, headers: { 'x-brd-err-code': 'client_10030' } });
    const { tryDirectBrightData, DirectEmptyBodyError } = load();
    const logger = require('../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    let threw: any = null;
    const out = await tryDirectBrightData('scrape_as_markdown', { url: 'https://x.com' }).catch((e: any) => { threw = e; return 'THREW'; });
    expect(out).toBeNull();
    expect(threw).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('client_10030'), expect.anything());
    expect(DirectEmptyBodyError).toBeDefined();
  });

  it('a 200 WITH body AND x-brd-err-code is still an upstream rejection (headers win over body)', async () => {
    mockPost.mockResolvedValue({ data: '{"organic":[]}', status: 200, headers: { 'x-brd-err-code': 'client_10020' } });
    const { tryDirectBrightData } = load();
    const logger = require('../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('client_10020'), expect.anything());
  });

  it('scrape_batch keeps upstream rejections loud: warn fires even though the failure is inlined', async () => {
    mockPost.mockResolvedValue({ data: '', status: 200, headers: { 'x-brd-err-code': 'client_10030' } });
    const { tryDirectBrightData } = load();
    const logger = require('../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    const out = await tryDirectBrightData('scrape_batch', { urls: ['https://a.com'] });
    expect(out).toContain('[scrape failed:');
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('UPSTREAM rejection'), expect.anything());
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('client_10030'), expect.anything());
  });

  it('token absent → one loud warn per process, then quiet', () => {
    delete process.env.BRIGHTDATA_API_TOKEN;
    jest.resetModules();
    const logger = require('../../utils/logger').default;
    (logger.warn as jest.Mock).mockClear();
    const fresh = require('./brightdata-direct');
    expect(fresh.directBrightDataAvailable()).toBe(false);
    expect(fresh.directBrightDataAvailable()).toBe(false);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('BRIGHTDATA_API_TOKEN'), expect.anything());
  });

  it('retries a transient 502 and recovers on a later attempt', async () => {
    mockPost
      .mockRejectedValueOnce(Object.assign(new Error('Bad Gateway'), { response: { status: 502 } }))
      .mockResolvedValue({ data: '{"organic": [{"link":"https://x.com","title":"t"}]}' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('search_engine', { query: 'q' });
    expect(out).toContain('"organic"');
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('retries a persistent 403 at most ONCE — permanent auth 403s fail fast to the gateway tier', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Forbidden'), { response: { status: 403 } }));
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('a transient 403 still recovers on the single allowed retry', async () => {
    mockPost
      .mockRejectedValueOnce(Object.assign(new Error('Forbidden'), { response: { status: 403 } }))
      .mockResolvedValue({ data: '{"organic": [{"link":"https://x.com","title":"t"}]}' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('search_engine', { query: 'q' });
    expect(out).toContain('"organic"');
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it('enforces an overall deadline (~1.5x timeout): a slow failing attempt is not retried', async () => {
    // timeoutMs=200 → total budget 300ms. The attempt burns ~250ms before its
    // retryable 503, so the ≥400ms backoff would land past the deadline.
    mockPost.mockImplementation(() => new Promise((_res, rej) =>
      setTimeout(() => rej(Object.assign(new Error('Service Unavailable'), { response: { status: 503 } })), 250)));
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 200)).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('honors a Retry-After header on 429 (waits at least that long before the retry)', async () => {
    mockPost
      .mockRejectedValueOnce(Object.assign(new Error('Too Many Requests'), {
        response: { status: 429, headers: { 'retry-after': '1' } },
      }))
      .mockResolvedValue({ data: '{"organic": [{"link":"https://x.com","title":"t"}]}' });
    const { tryDirectBrightData } = load();
    const t0 = Date.now();
    const out = await tryDirectBrightData('search_engine', { query: 'q' });
    expect(out).toContain('"organic"');
    expect(mockPost).toHaveBeenCalledTimes(2);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(950); // ≥ Retry-After (1s), not the 400ms base
  });

  it('scrape_batch shares one retry budget: a batch-wide 429 storm is capped, not multiplied', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('Too Many Requests'), { response: { status: 429 } }));
    const { tryDirectBrightData } = load();
    const urls = ['https://a.com', 'https://b.com', 'https://c.com', 'https://d.com', 'https://e.com'];
    const out = await tryDirectBrightData('scrape_batch', { urls });
    expect(out).toContain('[scrape failed:');
    // 5 initial requests + a shared budget of 4 retries = 9 total
    // (5 URLs × 3 attempts each = 15 without the shared budget).
    expect(mockPost).toHaveBeenCalledTimes(9);
  }, 10_000);

  it('never retries our own timeout (ECONNABORTED) — a slow target is not a transient', async () => {
    mockPost.mockRejectedValue(Object.assign(new Error('timeout of 60000ms exceeded'), { code: 'ECONNABORTED' }));
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('never retries a zone/ACL rejection (DirectUpstreamError is deterministic)', async () => {
    mockPost.mockResolvedValue({ data: '', status: 200, headers: { 'x-brd-err-code': 'client_10030' } });
    const { tryDirectBrightData } = load();
    expect(await tryDirectBrightData('search_engine', { query: 'q' })).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1);
  });
});

describe('unfetchable targets (autonomy loop #19: a raw-IP LiteLLM endpoint was refused by policy 26× in 4 h)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const load = () => require('./brightdata-direct');

  it('classifyUnfetchableTarget names raw IPs, private hosts, odd ports and bad URLs; public hostnames on 80/443 pass', () => {
    const { classifyUnfetchableTarget } = load();
    expect(classifyUnfetchableTarget('http://89.124.36.202:4000/v1/models')).toMatch(/raw IP address host 89\.124\.36\.202/);
    expect(classifyUnfetchableTarget('http://10.0.0.5/')).toMatch(/raw IP/);
    expect(classifyUnfetchableTarget('http://[::1]/')).toMatch(/raw IP/);
    expect(classifyUnfetchableTarget('http://localhost:3000/')).toMatch(/private hostname/);
    expect(classifyUnfetchableTarget('http://box.internal/x')).toMatch(/private hostname/);
    expect(classifyUnfetchableTarget('https://example.com:8443/')).toMatch(/non-standard port 8443/);
    expect(classifyUnfetchableTarget('ftp://example.com/')).toMatch(/unsupported scheme/);
    expect(classifyUnfetchableTarget('not a url')).toMatch(/not a valid absolute URL/);
    expect(classifyUnfetchableTarget('https://example.com/path')).toBeNull();
    expect(classifyUnfetchableTarget('http://example.com:80/')).toBeNull();
  });

  it('scrape_as_markdown of a raw-IP target rejects DirectUnfetchableTargetError (a DirectEmptyBodyError — the gateway is skipped) with NO request', async () => {
    const { tryDirectBrightData, DirectUnfetchableTargetError, DirectEmptyBodyError } = load();
    await expect(tryDirectBrightData('scrape_as_markdown', { url: 'http://89.124.36.202:4000/v1/models' })).rejects.toBeInstanceOf(DirectUnfetchableTargetError);
    await expect(tryDirectBrightData('scrape_as_markdown', { url: 'http://89.124.36.202:4000/v1/models' })).rejects.toBeInstanceOf(DirectEmptyBodyError);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('scrape_batch skips unfetchable URLs inline (with the sandbox hint) and still fetches the fetchable ones', async () => {
    mockPost.mockResolvedValue({ data: 'md-ok' });
    const { tryDirectBrightData } = load();
    const out = await tryDirectBrightData('scrape_batch', { urls: ['https://a.com', 'http://10.1.2.3:9000/x'] });
    expect(out).toContain('md-ok');
    expect(out).toContain('[scrape failed: unfetchable target: raw IP address host 10.1.2.3 — read it from the sandbox with run_command curl]');
    expect(mockPost).toHaveBeenCalledTimes(1);
  });

  it('a policy_20020 upstream refusal memoizes the HOST: the next scrape of that host fails fast as unfetchable without a request', async () => {
    mockPost.mockResolvedValue({ status: 200, data: '', headers: { 'x-brd-err-code': 'policy_20020', 'x-brd-err': 'target blocked by policy' } });
    const { tryDirectBrightData, classifyUnfetchableTarget, DirectUnfetchableTargetError } = load();
    expect(await tryDirectBrightData('scrape_as_markdown', { url: 'https://blocked.example.org/page' })).toBeNull(); // upstream → null (gateway may try)
    expect(mockPost).toHaveBeenCalledTimes(1);
    expect(classifyUnfetchableTarget('https://blocked.example.org/other')).toMatch(/refused this host by policy/);
    await expect(tryDirectBrightData('scrape_as_markdown', { url: 'https://blocked.example.org/other' })).rejects.toBeInstanceOf(DirectUnfetchableTargetError);
    expect(mockPost).toHaveBeenCalledTimes(1); // no second request
  });

  it('directScreenshotPng of an unfetchable target returns null without a request', async () => {
    const { directScreenshotPng } = load();
    expect(await directScreenshotPng('http://89.124.36.202:4000/v1/models')).toBeNull();
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('unfetchableGuidance names the URL, the reason and the run_command curl alternative', () => {
    const { unfetchableGuidance } = load();
    const g = unfetchableGuidance('http://89.124.36.202:4000/v1/models', 'raw IP address host 89.124.36.202');
    expect(g.startsWith('[unfetchable target]')).toBe(true);
    expect(g).toContain('raw IP address host');
    expect(g).toContain("run_command: curl -sS --max-time 20 'http://89.124.36.202:4000/v1/models'");
  });
});

// ── PE-06 (2026-09-28): the direct tier names WHY it missed ───────────────────
describe('direct-tier miss class (backlog audit PE-06): every null carries a DirectMissInfo through opts.onMiss', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });
  function load() {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require('./brightdata-direct');
  }

  it('classifySerpBody: consent / captcha / redirect / html / json shapes / other', () => {
    const { classifySerpBody } = load();
    expect(classifySerpBody('<html><body>Before you continue to Google … consent.google.com</body></html>')).toBe('consent');
    expect(classifySerpBody('<html>Our systems have detected unusual traffic … recaptcha</html>')).toBe('captcha');
    expect(classifySerpBody('<html><head><meta http-equiv="refresh" content="0;url=https://x"></head></html>')).toBe('redirect');
    expect(classifySerpBody('<!DOCTYPE html><html><body>hello</body></html>')).toBe('html');
    expect(classifySerpBody('{"general":{"query":"q"},"results":[]}')).toBe('json_no_organic');
    expect(classifySerpBody('{"general":')).toBe('json_malformed');
    expect(classifySerpBody('plain text nobody expected')).toBe('other');
    expect(classifySerpBody('')).toBe('other');
  });

  it('classifyDirectMiss maps every failure family to a stable class', () => {
    const { classifyDirectMiss, DirectUpstreamError, DirectEmptyBodyError, DirectSerpShapeError } = load();
    expect(classifyDirectMiss(new DirectUpstreamError('policy_20020', 200, 'refused'))).toEqual({ class: 'upstream_policy_20020', status: 200, code: 'policy_20020' });
    expect(classifyDirectMiss(new DirectSerpShapeError('captcha'))).toEqual({ class: 'serp_captcha', detail: 'captcha' });
    expect(classifyDirectMiss(new DirectEmptyBodyError('empty'))).toEqual({ class: 'empty_body' });
    expect(classifyDirectMiss({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' })).toEqual({ class: 'timeout', code: 'ECONNABORTED' });
    expect(classifyDirectMiss({ response: { status: 502 }, message: 'Request failed' })).toEqual({ class: 'http_502', status: 502 });
    expect(classifyDirectMiss({ code: 'ECONNRESET', message: 'socket hang up' })).toEqual({ class: 'net_ECONNRESET', code: 'ECONNRESET' });
    expect(classifyDirectMiss(new Error('something odd'))).toEqual({ class: 'error', detail: 'something odd' });
    expect(classifyDirectMiss(undefined).class).toBe('error');
  });

  it('a SERP with no organic key → onMiss serp_<bodyClass> (the old "missing organic results" message survives, now with the class)', async () => {
    mockPost.mockResolvedValue({ data: '<html>Our systems have detected unusual traffic</html>' });
    const { tryDirectBrightData } = load();
    const onMiss = jest.fn();
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(onMiss).toHaveBeenCalledTimes(1);
    expect(onMiss).toHaveBeenCalledWith({ class: 'serp_captcha', detail: 'captcha' });
    const logger = require('../../utils/logger').default;
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('direct SERP response missing organic results (captcha)'), expect.anything());
  });

  it('empty body (search) → empty_body; upstream header → upstream_<code>; timeout → timeout; token absent → no_token', async () => {
    const { tryDirectBrightData } = load();
    let onMiss = jest.fn();
    mockPost.mockResolvedValue({ data: '' });
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(onMiss).toHaveBeenCalledWith({ class: 'empty_body' });

    onMiss = jest.fn();
    mockPost.mockResolvedValue({ data: '', status: 200, headers: { 'x-brd-err-code': 'client_10030', 'x-brd-err': 'ip_forbidden' } });
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(onMiss).toHaveBeenCalledWith({ class: 'upstream_client_10030', status: 200, code: 'client_10030' });

    onMiss = jest.fn();
    mockPost.mockRejectedValue({ code: 'ECONNABORTED', message: 'timeout of 60000ms exceeded' });
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(onMiss).toHaveBeenCalledWith({ class: 'timeout', code: 'ECONNABORTED' });

    onMiss = jest.fn();
    delete process.env.BRIGHTDATA_API_TOKEN;
    jest.resetModules();
    const fresh = load();
    expect(await fresh.tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(onMiss).toHaveBeenCalledWith({ class: 'no_token' });
  });

  it('a successful call never reports a miss, and a throwing onMiss never breaks the call', async () => {
    mockPost.mockResolvedValue({ data: '{"organic": [{"link":"https://x.com","title":"t"}]}' });
    const { tryDirectBrightData } = load();
    const onMiss = jest.fn();
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toContain('"organic"');
    expect(onMiss).not.toHaveBeenCalled();
    mockPost.mockResolvedValue({ data: '' });
    const boom = jest.fn(() => { throw new Error('telemetry bug'); });
    await expect(tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss: boom })).resolves.toBeNull();
  });

  it('scrape_as_markdown deterministic empty still THROWS (contract #85) and reports no miss (the caller records it as deterministic)', async () => {
    mockPost.mockResolvedValue({ data: '' });
    const { tryDirectBrightData, DirectEmptyBodyError } = load();
    const onMiss = jest.fn();
    await expect(tryDirectBrightData('scrape_as_markdown', { url: 'https://example.com/a' }, 60_000, { onMiss })).rejects.toBeInstanceOf(DirectEmptyBodyError);
    expect(onMiss).not.toHaveBeenCalled();
  });
});

// ── Log-signal family lane — ticket 8843b3bd (2026-10-27) ──────────────────────
// Characterization pin: 67 rows/24h of
//   BrightData direct: search_engine failed:  direct SERP response missing
//   organic results (json_no_organic)
// (the RAW row carries a DOUBLE space — the empty HTTP-status slot in the
// generic warn template; the sweep's fingerprint collapses it). The emitting
// site is THIS module's own SERP sanity check: a 200 body that parses as JSON
// but carries no "organic" key throws DirectSerpShapeError('json_no_organic')
// — a deterministic content shape, NOT retryable (isRetryableBdError has no
// HTTP status to match), so ONE POST, ONE warn, a serp_json_no_organic miss
// row, and null → the gateway tier answers. Designed failover observability,
// not a defect: silence or a retry loop here is exactly what the PE-06/#85
// contract forbids.
describe('log-signal 8843b3bd — the json_no_organic SERP shape is designed failover observability (one POST, one warn, gateway failover)', () => {
  beforeEach(() => {
    jest.resetModules();
    mockPost.mockReset();
    process.env.BRIGHTDATA_API_TOKEN = 'test-token';
  });
  function load() {
    // re-require after env is set (module reads env at import)
    return require('./brightdata-direct');
  }

  it('REPLAYS the prod row: a JSON body with no "organic" key is not retried, logs the exact double-space warn, reports the miss class, and returns null for the gateway tier', async () => {
    mockPost.mockResolvedValue({ data: '{"general":{"query":"q"},"results":[]}' });
    const { tryDirectBrightData, DirectSerpShapeError, classifyDirectMiss } = load();
    const onMiss = jest.fn();
    expect(await tryDirectBrightData('search_engine', { query: 'q' }, 60_000, { onMiss })).toBeNull();
    expect(mockPost).toHaveBeenCalledTimes(1); // deterministic shape — never retried (no retry storm)
    const logger = require('../../utils/logger').default;
    expect(logger.warn).toHaveBeenCalledWith(
      'BrightData direct: search_engine failed:  direct SERP response missing organic results (json_no_organic)',
      { source: 'brightdata-direct', tool: 'search_engine' },
    );
    expect(onMiss).toHaveBeenCalledWith({ class: 'serp_json_no_organic', detail: 'json_no_organic' });
    // the classifier the web_fetch_path row records (directClass) for this shape
    expect(classifyDirectMiss(new DirectSerpShapeError('json_no_organic'))).toEqual({ class: 'serp_json_no_organic', detail: 'json_no_organic' });
    expect((logger.error as jest.Mock).mock.calls).toHaveLength(0); // warn level — the sweep reads warn+
  });
});
