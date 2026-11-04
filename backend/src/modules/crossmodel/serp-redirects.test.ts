/**
 * SERP redirect-wrapper unwrapping — owner 2026-09-14 "is our web_pipe broken??".
 *
 * Since ~2026-09-13 BrightData's Google SERP returns organic[].link as
 * https://www.google.com/goto?url=<opaque> wrappers. A GET with maxRedirects:0
 * answers 302 + Location:<real URL>; scrape_as_markdown on the wrapper answers
 * "this endpoint is not supported". These tests pin the helper: one hop,
 * resolved Location, wrapper-chain / non-redirect / non-http / timeout → the
 * original URL, per-process cache (one request for two calls), bounded
 * concurrency, order-preserving batch map, the JSON rewrite, and the kill
 * switch. Never throws.
 */
import axios from 'axios';
import logger from '../../utils/logger';
import {
  isSerpRedirectWrapper,
  decodeSerpRedirectLocally,
  unwrapSerpRedirect,
  unwrapSerpLinks,
  unwrapSerpJsonText,
  clearSerpRedirectCache,
  serpRedirectCacheSize,
} from './serp-redirects';

jest.mock('axios');
jest.mock('../../utils/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGet = axios.get as jest.Mock;
const mockInfo = (logger as any).info as jest.Mock;

// The live prod shape (16:00Z sample): opaque token, NOT a decodable URL.
const GOTO = 'https://www.google.com/goto?url=CAESQ0FVX3lxTE1nVzNtV2hZWDNqZk5oV0dJc3RJM1hLbVo1RDNZ';
const GOTO_2 = 'https://www.google.com/goto?url=CAESQ0FVX3lxTE5iZ2VhSEtTTmF0Sk5vTzFvMlhaQWc5';
const REAL = 'https://vllm.ai/blog/2026-07-27-k3';
const REAL_2 = 'https://moonshot.ai/kimi-k3';

const redirect = (location: string | undefined, status = 302) => ({ status, headers: location === undefined ? {} : { location }, data: '' });

beforeEach(() => {
  jest.clearAllMocks();
  clearSerpRedirectCache();
  mockGet.mockRejectedValue(new Error('unexpected request in this test'));
});

describe('isSerpRedirectWrapper', () => {
  test.each([
    ['Google goto (the live prod shape)', GOTO],
    ['Google /url?q=', 'https://www.google.com/url?q=https://example.com/a&sa=U'],
    ['Google /url?url=', 'https://google.com/url?url=https://example.com/a'],
    ['Google ccTLD /url', 'https://www.google.co.uk/url?q=https://example.com/a'],
    ['Google compound ccTLD /goto', 'https://www.google.com.au/goto?url=CAES'],
    ['Bing /ck/a?u=', 'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9wYWdl&ntb=1'],
    ['DuckDuckGo /l/?uddg=', 'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc'],
  ])('%s → true', (_d, url) => {
    expect(isSerpRedirectWrapper(url)).toBe(true);
  });

  test.each([
    ['a plain result URL', REAL],
    ['google.com/search itself', 'https://www.google.com/search?q=kimi+k3'],
    ['google /goto without url param', 'https://www.google.com/goto?x=1'],
    ['google /url without q or url', 'https://www.google.com/url?sa=U'],
    ['a google product page', 'https://www.google.com/maps'],
    ['a lookalike host', 'https://notgoogle.com/goto?url=CAES'],
    ['bing /ck/a without u', 'https://www.bing.com/ck/a?p=1'],
    ['bing search', 'https://www.bing.com/search?q=x'],
    ['ddg search', 'https://duckduckgo.com/?q=x'],
    ['non-http scheme', 'ftp://www.google.com/goto?url=CAES'],
    ['not a URL', 'goto?url=CAES'],
    ['empty', ''],
  ])('%s → false', (_d, url) => {
    expect(isSerpRedirectWrapper(url)).toBe(false);
  });
});

describe('decodeSerpRedirectLocally (no network when the target rides in the wrapper)', () => {
  test('Google /url?q= carries the real URL', () => {
    expect(decodeSerpRedirectLocally('https://www.google.com/url?q=https://example.com/a?b%3D1&sa=U')).toBe('https://example.com/a?b=1');
  });
  test('Bing u=a1<base64url> decodes', () => {
    const b64 = Buffer.from('https://example.com/page?x=1&y=2').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(decodeSerpRedirectLocally(`https://www.bing.com/ck/a?!&&p=abc&u=a1${b64}&ntb=1`)).toBe('https://example.com/page?x=1&y=2');
  });
  test('DuckDuckGo uddg decodes', () => {
    expect(decodeSerpRedirectLocally('https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fpage&rut=abc')).toBe('https://example.com/page');
  });
  test('Google goto with an OPAQUE token → null (needs the network hop)', () => {
    expect(decodeSerpRedirectLocally(GOTO)).toBeNull();
  });
  test('a wrapper whose payload is another wrapper → null', () => {
    expect(decodeSerpRedirectLocally(`https://www.google.com/url?q=${encodeURIComponent(GOTO)}`)).toBeNull();
  });
  test('Bing payload without the a1 prefix, or junk → null', () => {
    expect(decodeSerpRedirectLocally('https://www.bing.com/ck/a?u=aHR0cHM6Ly9leGFtcGxlLmNvbQ')).toBeNull();
    expect(decodeSerpRedirectLocally('https://www.bing.com/ck/a?u=a1%%%')).toBeNull();
  });
  test('non-wrapper → null', () => {
    expect(decodeSerpRedirectLocally(REAL)).toBeNull();
  });
});

describe('unwrapSerpRedirect — ONE hop', () => {
  test('302 with an absolute Location → the real URL; request shape is a no-follow browser GET', async () => {
    mockGet.mockResolvedValue(redirect(REAL));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(REAL);
    expect(mockGet).toHaveBeenCalledTimes(1);
    const [url, opts] = mockGet.mock.calls[0];
    expect(url).toBe(GOTO);
    expect(opts).toMatchObject({ maxRedirects: 0, timeout: 5000 });
    expect(opts.validateStatus()).toBe(true);
    expect(String(opts.headers['User-Agent'])).toMatch(/^Mozilla\/5\.0/);
  });

  test.each([301, 303, 307, 308])('%s counts as a redirect too', async (status) => {
    mockGet.mockResolvedValue(redirect(REAL, status));
    await expect(unwrapSerpRedirect(`${GOTO}${status}`)).resolves.toBe(REAL);
  });

  test('a RELATIVE Location resolves against the wrapper', async () => {
    mockGet.mockResolvedValue(redirect('/some/landing?x=1'));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe('https://www.google.com/some/landing?x=1');
  });

  test('a scheme-relative Location resolves against the wrapper scheme', async () => {
    mockGet.mockResolvedValue(redirect('//vllm.ai/blog/2026-07-27-k3'));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(REAL);
  });

  test('HTTP 200 (no redirect) → the original URL', async () => {
    mockGet.mockResolvedValue({ status: 200, headers: { 'content-type': 'text/html' }, data: '<html>this endpoint is not supported</html>' });
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
  });

  test('4xx/5xx → the original URL', async () => {
    mockGet.mockResolvedValue({ status: 403, headers: {}, data: '' });
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
  });

  test('302 to ANOTHER wrapper → the original URL (no chain following)', async () => {
    mockGet.mockResolvedValue(redirect(GOTO_2));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('302 to a non-http target → the original URL', async () => {
    mockGet.mockResolvedValue(redirect('javascript:alert(1)'));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
  });

  test('302 without a Location header → the original URL', async () => {
    mockGet.mockResolvedValue(redirect(undefined));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
  });

  test('timeout / network error → the original URL, never a throw', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('timeout of 5000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(GOTO);
  });

  test('a custom timeoutMs is honoured', async () => {
    mockGet.mockResolvedValue(redirect(REAL));
    await unwrapSerpRedirect(GOTO, { timeoutMs: 1234 });
    expect(mockGet.mock.calls[0][1]).toMatchObject({ timeout: 1234 });
  });

  test('a non-wrapper URL is returned unchanged with NO request', async () => {
    await expect(unwrapSerpRedirect(REAL)).resolves.toBe(REAL);
    await expect(unwrapSerpRedirect('not a url')).resolves.toBe('not a url');
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('locally-decodable wrappers never touch the network', async () => {
    await expect(unwrapSerpRedirect('https://www.google.com/url?q=https://example.com/a')).resolves.toBe('https://example.com/a');
    expect(mockGet).not.toHaveBeenCalled();
  });
});

describe('unwrapSerpRedirect — cache', () => {
  test('cache hit: two calls for the same wrapper make ONE request', async () => {
    mockGet.mockResolvedValue(redirect(REAL));
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(REAL);
    await expect(unwrapSerpRedirect(GOTO)).resolves.toBe(REAL);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(serpRedirectCacheSize()).toBe(1);
  });

  test('an unresolvable wrapper is negatively cached — no re-hammering within the cooldown', async () => {
    mockGet.mockResolvedValue({ status: 200, headers: {}, data: '' });
    await unwrapSerpRedirect(GOTO);
    await unwrapSerpRedirect(GOTO);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test('concurrent calls for the same wrapper share ONE in-flight request', async () => {
    let release!: (v: any) => void;
    mockGet.mockImplementation(() => new Promise(r => { release = r; }));
    const a = unwrapSerpRedirect(GOTO);
    const b = unwrapSerpRedirect(GOTO);
    await Promise.resolve();
    expect(mockGet).toHaveBeenCalledTimes(1);
    release(redirect(REAL));
    await expect(Promise.all([a, b])).resolves.toEqual([REAL, REAL]);
  });

  test('clearSerpRedirectCache forgets — the next call requests again', async () => {
    mockGet.mockResolvedValue(redirect(REAL));
    await unwrapSerpRedirect(GOTO);
    clearSerpRedirectCache();
    await unwrapSerpRedirect(GOTO);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });
});

describe('unwrapSerpLinks — bounded, order-preserving batch map', () => {
  test('order preserved, other fields kept, non-wrappers untouched, ONE info line with counts', async () => {
    mockGet.mockImplementation(async (url: string) => {
      if (url === GOTO) return redirect(REAL);
      if (url === GOTO_2) return redirect(REAL_2);
      throw new Error(`unexpected ${url}`);
    });
    const items = [
      { url: GOTO, title: 'K3 blog' },
      { url: 'https://plain.example/page', title: 'Plain' },
      { url: GOTO_2, title: 'Kimi' },
    ];
    const out = await unwrapSerpLinks(items);
    expect(out).toEqual([
      { url: REAL, title: 'K3 blog' },
      { url: 'https://plain.example/page', title: 'Plain' },
      { url: REAL_2, title: 'Kimi' },
    ]);
    expect(items[0].url).toBe(GOTO); // input not mutated
    expect(mockGet).toHaveBeenCalledTimes(2);
    expect(mockInfo).toHaveBeenCalledTimes(1);
    expect(mockInfo.mock.calls[0][0]).toContain('unwrapped 2/2 SERP redirect wrapper(s) in a batch of 3');
  });

  test('a batch with no wrappers makes no requests and logs nothing', async () => {
    const items = [{ url: REAL }, { url: REAL_2 }];
    await expect(unwrapSerpLinks(items)).resolves.toEqual(items);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });

  test('unresolvable wrappers stay as-is and are counted in the log line', async () => {
    mockGet.mockImplementation(async (url: string) => (url === GOTO ? redirect(REAL) : { status: 200, headers: {}, data: '' }));
    const out = await unwrapSerpLinks([{ url: GOTO }, { url: GOTO_2 }]);
    expect(out.map(o => o.url)).toEqual([REAL, GOTO_2]);
    expect(mockInfo.mock.calls[0][0]).toMatch(/unwrapped 1\/2 .* 1 unresolved, kept as-is/);
  });

  test('concurrency is bounded (default 6; opts.concurrency honoured)', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    mockGet.mockImplementation((url: string) => new Promise(resolve => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      setTimeout(() => {
        inFlight--;
        resolve(redirect(`https://real.example/${new URL(url).searchParams.get('url')}`));
      }, 5);
    }));
    const items = Array.from({ length: 10 }, (_, i) => ({ url: `https://www.google.com/goto?url=TOKEN${i}` }));
    const out = await unwrapSerpLinks(items, { concurrency: 3 });
    expect(maxInFlight).toBeLessThanOrEqual(3);
    expect(out.map(o => o.url)).toEqual(items.map((_, i) => `https://real.example/TOKEN${i}`));
    expect(mockGet).toHaveBeenCalledTimes(10);
  });

  test('cache hits inside a batch are reported and cost no request', async () => {
    mockGet.mockResolvedValue(redirect(REAL));
    await unwrapSerpRedirect(GOTO); // warm
    mockGet.mockClear();
    await unwrapSerpLinks([{ url: GOTO }]);
    expect(mockGet).not.toHaveBeenCalled();
    expect(mockInfo.mock.calls.at(-1)[0]).toContain('(1 from cache)');
  });

  test('empty / non-array input is returned as-is', async () => {
    await expect(unwrapSerpLinks([])).resolves.toEqual([]);
    await expect(unwrapSerpLinks(undefined as any)).resolves.toBeUndefined();
  });
});

describe('unwrapSerpJsonText — the SERP the model reads', () => {
  const SERP = {
    general: { search_engine: 'google', query: 'kimi k3' },
    organic: [
      { link: GOTO, source: 'vLLM Blog', display_link: 'vllm.ai', title: 'K3 on vLLM', description: 'd', rank: 1, global_rank: 1 },
      { link: 'https://plain.example/page', title: 'Plain', rank: 2, global_rank: 2 },
    ],
    news: [{ link: GOTO_2, title: 'Kimi K3 launch' }],
    navigation: [{ title: 'Images', href: 'https://www.google.com/search?tbm=isch' }],
  };

  test('rewrites organic[].link and news[].link; everything else is preserved', async () => {
    mockGet.mockImplementation(async (url: string) => (url === GOTO ? redirect(REAL) : url === GOTO_2 ? redirect(REAL_2) : { status: 200, headers: {}, data: '' }));
    const out = JSON.parse(await unwrapSerpJsonText(JSON.stringify(SERP)));
    expect(out.organic[0]).toEqual({ ...SERP.organic[0], link: REAL });
    expect(out.organic[1]).toEqual(SERP.organic[1]);
    expect(out.news[0]).toEqual({ link: REAL_2, title: 'Kimi K3 launch' });
    expect(out.general).toEqual(SERP.general);
    expect(out.navigation).toEqual(SERP.navigation);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test('a SERP with no wrappers is returned byte-identical with no requests', async () => {
    const clean = JSON.stringify({ organic: [{ link: REAL, title: 'x' }] });
    await expect(unwrapSerpJsonText(clean)).resolves.toBe(clean);
    expect(mockGet).not.toHaveBeenCalled();
  });

  test('when every wrapper is unresolvable the text is returned unchanged', async () => {
    mockGet.mockResolvedValue({ status: 200, headers: {}, data: '' });
    const text = JSON.stringify(SERP);
    await expect(unwrapSerpJsonText(text)).resolves.toBe(text);
  });

  test('non-JSON text is returned unchanged; a non-JSON prefix is preserved', async () => {
    const plain = `Results: ${GOTO} and more`;
    await expect(unwrapSerpJsonText(plain)).resolves.toBe(plain);
    mockGet.mockResolvedValue(redirect(REAL));
    const prefixed = `NOTE: raw\n${JSON.stringify({ organic: [{ link: GOTO }] })}`;
    const out = await unwrapSerpJsonText(prefixed);
    expect(out.startsWith('NOTE: raw\n')).toBe(true);
    expect(JSON.parse(out.slice('NOTE: raw\n'.length)).organic[0].link).toBe(REAL);
  });

  test('a JSON array or empty input passes through', async () => {
    const arr = JSON.stringify([{ link: GOTO }]);
    await expect(unwrapSerpJsonText(arr)).resolves.toBe(arr);
    await expect(unwrapSerpJsonText('')).resolves.toBe('');
    expect(mockGet).not.toHaveBeenCalled();
  });
});
