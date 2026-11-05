/**
 * probeTelegramWebhook — the one outbound call the setup page makes, and only
 * on a non-prod instance (2026-10-20 self-host hardening). Production never
 * reaches Telegram from this endpoint; the token never leaves the process.
 */
import { probeTelegramWebhook, _resetTelegramWebhookCache } from './telegram-webhook-probe';

jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

const SELFHOST = { DIGBY_INSTANCE: 'selfhost', SELFHOST_PUBLIC_URL: 'https://digby.cql.ca', TELEGRAM_BOT_TOKEN: 'tok' } as NodeJS.ProcessEnv;
const PROD = { FRONTEND_URL: 'https://digby.ai', TELEGRAM_BOT_TOKEN: 'tok' } as NodeJS.ProcessEnv;

describe('probeTelegramWebhook', () => {
  const realFetch = (global as any).fetch;
  let fetchMock: jest.Mock;
  beforeEach(() => {
    _resetTelegramWebhookCache();
    fetchMock = jest.fn();
    (global as any).fetch = fetchMock;
  });
  afterAll(() => { (global as any).fetch = realFetch; });

  it('never calls Telegram on a production instance', async () => {
    expect(await probeTelegramWebhook(PROD)).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('is not probed without a token or a public URL', async () => {
    expect(await probeTelegramWebhook({ DIGBY_INSTANCE: 'selfhost', SELFHOST_PUBLIC_URL: 'https://x' })).toBeUndefined();
    expect(await probeTelegramWebhook({ DIGBY_INSTANCE: 'selfhost', TELEGRAM_BOT_TOKEN: 'tok' })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it('compares the registered url with THIS instance\'s webhook and caches the answer', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { url: 'https://digby.cql.ca/api/crossmodel/telegram/webhook' } }) });
    expect(await probeTelegramWebhook(SELFHOST, 1_000)).toEqual({ registered: true, url: 'https://digby.cql.ca/api/crossmodel/telegram/webhook' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.telegram.org/bottok/getWebhookInfo');
    expect(await probeTelegramWebhook(SELFHOST, 2_000)).toEqual({ registered: true, url: 'https://digby.cql.ca/api/crossmodel/telegram/webhook' });
    expect(fetchMock).toHaveBeenCalledTimes(1); // cached
  });
  it('reports a foreign or empty registration as not registered', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { url: '' } }) });
    expect(await probeTelegramWebhook(SELFHOST, 1_000)).toEqual({ registered: false, url: null });
    _resetTelegramWebhookCache();
    fetchMock.mockResolvedValue({ json: async () => ({ ok: true, result: { url: 'https://digby.ai/api/crossmodel/telegram/webhook' } }) });
    expect(await probeTelegramWebhook(SELFHOST, 1_000)).toEqual({ registered: false, url: 'https://digby.ai/api/crossmodel/telegram/webhook' });
  });
  it('answers null (not undefined) when Telegram is unreachable, and retries after the short failure cache', async () => {
    fetchMock.mockRejectedValue(new Error('ENOTFOUND'));
    expect(await probeTelegramWebhook(SELFHOST, 1_000)).toBeNull();
    expect(await probeTelegramWebhook(SELFHOST, 30_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await probeTelegramWebhook(SELFHOST, 90_000)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
