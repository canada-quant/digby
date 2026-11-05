/**
 * audit 2026-10-08 W2-3 — the gateway's LiteLLM /model/info window, read at
 * run time (coding/gateway-model-info.ts). Fake timers throughout: the 1.5 s
 * resolve wait and the cache TTLs are driven by the jest clock, never the wall.
 */
jest.mock('axios');
import axios from 'axios';
import {
  gatewayModelInfoWindow, refreshGatewayModelInfo, gatewayModelInfoRuntimeDisabled, gatewayModelInfoRuntimeEnabled,
  litellmMaxInputTokens, litellmModelInfoUrls, litellmWindowsByModel, __resetGatewayModelInfoForTests,
  MODEL_INFO_TTL_MS, MODEL_INFO_FAIL_TTL_MS, RESOLVE_WAIT_MS,
} from './gateway-model-info';

const mockGet = axios.get as unknown as jest.Mock;
const BASE = 'https://llm.cql.ca/v1';

/** The LiteLLM /model/info shape: one row per DEPLOYMENT of a model group. */
const BODY = {
  data: [
    { model_name: 'api-alibaba-qwen3.8-max', model_info: { max_input_tokens: 983_616 } },
    { model_name: 'api-alibaba-qwen3.8-max', model_info: { max_input_tokens: 262_144 } }, // a smaller second deployment
    { model_name: 'api-optimize-zai-glm-5.3', model_info: { max_input_tokens: null } },
    { model_name: 'spark-qwen3.8-flash-next', model_info: { max_input_tokens: 131_072 } },
  ],
};

beforeEach(() => {
  jest.useFakeTimers();
  mockGet.mockReset();
  __resetGatewayModelInfoForTests();
  delete process.env.GATEWAY_MODEL_INFO_RUNTIME_DISABLED;
  delete process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST;
});
afterEach(() => { jest.useRealTimers(); });

describe('pure parsers (moved from capability-detect — still re-exported there)', () => {
  it('the group window is the MIN across its deployments; unknown / non-numeric → null', () => {
    expect(litellmMaxInputTokens(BODY, 'api-alibaba-qwen3.8-max')).toEqual({ tokens: 262_144, deployments: 2 });
    expect(litellmMaxInputTokens(BODY, 'api-optimize-zai-glm-5.3')).toBeNull();
    expect(litellmMaxInputTokens({}, 'x')).toBeNull();
    const m = litellmWindowsByModel(BODY);
    expect(m.get('api-alibaba-qwen3.8-max')).toBe(262_144);
    expect(m.get('spark-qwen3.8-flash-next')).toBe(131_072);
    expect(m.has('api-optimize-zai-glm-5.3')).toBe(false);
  });
  it('urls: /v1 base → /v1/model/info then /model/info', () => {
    expect(litellmModelInfoUrls('https://llm.cql.ca/v1/')).toEqual(['https://llm.cql.ca/v1/model/info', 'https://llm.cql.ca/model/info']);
  });
  it('capability-detect re-exports the same functions', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const src = require('fs').readFileSync(require('path').join(__dirname, '../model-endpoints/capability-detect.ts'), 'utf8');
    expect(src).toContain("export { litellmModelInfoUrls, litellmMaxInputTokens } from '../coding/gateway-model-info';");
  });
});

describe('gatewayModelInfoWindow', () => {
  it('fetches once with the bearer key, answers the model window, and serves later calls from the cache', async () => {
    mockGet.mockResolvedValueOnce({ data: BODY });
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'sk-gw', model: 'api-alibaba-qwen3.8-max' })).toBe(262_144);
    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(mockGet.mock.calls[0][0]).toBe(`${BASE}/model/info`);
    expect(mockGet.mock.calls[0][1]).toMatchObject({ headers: { Authorization: 'Bearer sk-gw' }, timeout: 3_000 });
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'sk-gw', model: 'spark-qwen3.8-flash-next' })).toBe(131_072);
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'sk-gw', model: 'not-listed' })).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(1);
    // 6 h later the entry is stale → one refetch.
    jest.setSystemTime(Date.now() + MODEL_INFO_TTL_MS + 1);
    mockGet.mockResolvedValueOnce({ data: BODY });
    await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'sk-gw', model: 'api-alibaba-qwen3.8-max' });
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('a non-LiteLLM endpoint (404 on both paths) is negative-cached for 30 min', async () => {
    mockGet.mockRejectedValue(Object.assign(new Error('404'), { response: { status: 404 } }));
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, model: 'm' })).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(2); // /v1/model/info then /model/info
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, model: 'm' })).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(2);
    jest.setSystemTime(Date.now() + MODEL_INFO_FAIL_TTL_MS + 1);
    await gatewayModelInfoWindow({ baseUrl: BASE, model: 'm' });
    expect(mockGet).toHaveBeenCalledTimes(4);
  });

  it('a body with no data[] list falls through to the alias path', async () => {
    mockGet.mockResolvedValueOnce({ data: { error: 'nope' } }).mockResolvedValueOnce({ data: BODY });
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, model: 'api-alibaba-qwen3.8-max' })).toBe(262_144);
    expect(mockGet.mock.calls.map((c) => c[0])).toEqual([`${BASE}/model/info`, 'https://llm.cql.ca/model/info']);
  });

  it('single-flight: concurrent resolves share ONE fetch', async () => {
    let release!: (v: any) => void;
    mockGet.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const a = gatewayModelInfoWindow({ baseUrl: BASE, model: 'api-alibaba-qwen3.8-max', waitMs: 10_000 });
    const b = gatewayModelInfoWindow({ baseUrl: BASE, model: 'spark-qwen3.8-flash-next', waitMs: 10_000 });
    release({ data: BODY });
    expect(await a).toBe(262_144);
    expect(await b).toBe(131_072);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it(`the resolve path waits at most ${RESOLVE_WAIT_MS} ms, then proceeds without it — the fetch keeps filling the cache`, async () => {
    let release!: (v: any) => void;
    mockGet.mockReturnValueOnce(new Promise((r) => { release = r; }));
    const p = gatewayModelInfoWindow({ baseUrl: BASE, model: 'api-alibaba-qwen3.8-max' });
    await jest.advanceTimersByTimeAsync(RESOLVE_WAIT_MS);
    expect(await p).toBeNull();
    release({ data: BODY });
    await jest.advanceTimersByTimeAsync(0);
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, model: 'api-alibaba-qwen3.8-max' })).toBe(262_144);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by endpoint AND key (two keys on one gateway may see different model lists)', async () => {
    mockGet.mockResolvedValueOnce({ data: BODY }).mockResolvedValueOnce({ data: { data: [] } });
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'k1', model: 'api-alibaba-qwen3.8-max' })).toBe(262_144);
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, apiKey: 'k2', model: 'api-alibaba-qwen3.8-max' })).toBeNull();
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  it('never throws; a direct refresh never rejects', async () => {
    mockGet.mockImplementation(() => { throw new Error('sync boom'); });
    await expect(gatewayModelInfoWindow({ baseUrl: BASE, model: 'm' })).resolves.toBeNull();
    await expect(refreshGatewayModelInfo('https://other/v1')).resolves.toMatchObject({ ok: false });
  });

  it('kill switch GATEWAY_MODEL_INFO_RUNTIME_DISABLED=1: no fetch, null', async () => {
    process.env.GATEWAY_MODEL_INFO_RUNTIME_DISABLED = '1';
    expect(gatewayModelInfoRuntimeDisabled()).toBe(true);
    expect(gatewayModelInfoRuntimeEnabled()).toBe(false);
    expect(await gatewayModelInfoWindow({ baseUrl: BASE, model: 'api-alibaba-qwen3.8-max' })).toBeNull();
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('under jest the run-path fetch is OFF unless GATEWAY_MODEL_INFO_RUNTIME_IN_TEST=1', () => {
    expect(gatewayModelInfoRuntimeEnabled()).toBe(false);
    process.env.GATEWAY_MODEL_INFO_RUNTIME_IN_TEST = '1';
    expect(gatewayModelInfoRuntimeEnabled()).toBe(true);
  });
});
