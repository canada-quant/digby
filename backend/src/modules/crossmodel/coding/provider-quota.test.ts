/**
 * 2026-09-29 — provider quota / usage-limit rejections are TRANSIENT
 * (provider-quota.ts). Prod: the gateway kimi-k3 group's weekly-limit 403 was
 * treated as a size rejection (100 shrinks, 48 runs given up in one hour).
 */
import { isProviderQuotaRejection, PROVIDER_QUOTA_RE } from './provider-quota';

const WEEKLY = "litellm.APIError: APIError: OpenAIException - You've reached your weekly (7-day) usage limit. Your quota will reset when the current 7-day window ends. To continue now, purchase extra usage or upgrade";

describe('isProviderQuotaRejection', () => {
  it.each([
    [403, WEEKLY],
    [402, 'Insufficient balance, please recharge'],
    [403, 'You exceeded your current quota, please check your plan and billing details.'],
    [429, 'Rate limit reached for requests'],
    [403, 'daily usage limit reached for this key'],
  ])('HTTP %d "%s" → transient', (status, text) => {
    expect(isProviderQuotaRejection({ errorStatus: status, providerError: text })).toBe(true);
  });
  it('a 403 without quota wording, a 400, or no status is NOT a quota rejection', () => {
    expect(isProviderQuotaRejection({ errorStatus: 403, providerError: 'Forbidden: invalid API key' })).toBe(false);
    expect(isProviderQuotaRejection({ errorStatus: 403, providerError: 'model not allowed for this key' })).toBe(false);
    expect(isProviderQuotaRejection({ errorStatus: 400, providerError: WEEKLY })).toBe(false);
    expect(isProviderQuotaRejection({ providerError: WEEKLY })).toBe(false);
  });
  it('reads the error message too', () => {
    expect(isProviderQuotaRejection({ errorStatus: 403, errorMessage: WEEKLY })).toBe(true);
  });
  it('the regex does not fire on ordinary tool / size errors', () => {
    expect(PROVIDER_QUOTA_RE.test('messages parameter is illegal')).toBe(false);
    expect(PROVIDER_QUOTA_RE.test("This model's maximum context length is 32768 tokens")).toBe(false);
  });
});
