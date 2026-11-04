/**
 * probeTelegramWebhook — has Telegram been told THIS instance's webhook URL?
 * (self-host setup hardening, 2026-10-20)
 *
 * The one outbound call the setup page makes, and only on a NON-prod instance:
 * production never reaches Telegram from this endpoint and its Telegram row
 * stays byte-identical (`undefined` = not probed). The bot token never leaves
 * the process; the answer is booleans + the registered url. A leaf (no env /
 * Prisma import) so it is testable with a mocked fetch.
 */
import logger from '../../../utils/logger';
import { isProdInstance } from './instance-targets';
import { instancePublicUrl, telegramWebhookUrl, type TelegramWebhookProbe } from './instance-setup';

const PROBE_TIMEOUT_MS = 4_000;
/** getWebhookInfo answers are cached in-process: 5 min when Telegram answered, 1 min after a failure. */
const TG_WEBHOOK_CACHE_OK_MS = 5 * 60_000;
const TG_WEBHOOK_CACHE_FAIL_MS = 60_000;
let _tgWebhookCache: { at: number; value: TelegramWebhookProbe | null } | null = null;

/**
 * Has Telegram been told this instance's webhook URL? Probed on a NON-prod
 * instance only (production never makes this call and its row stays
 * byte-identical), with a bot token + public URL to compare against. The token
 * never leaves the process; the answer is names/booleans. undefined = not
 * probed; null = Telegram unreachable.
 */
export async function probeTelegramWebhook(env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<TelegramWebhookProbe | null | undefined> {
  if (isProdInstance(env)) return undefined;
  const token = env.TELEGRAM_BOT_TOKEN;
  const expected = telegramWebhookUrl(instancePublicUrl(env));
  if (!token || !expected) return undefined;
  if (_tgWebhookCache && now - _tgWebhookCache.at < (_tgWebhookCache.value ? TG_WEBHOOK_CACHE_OK_MS : TG_WEBHOOK_CACHE_FAIL_MS)) return _tgWebhookCache.value;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT_MS);
  try {
    const r = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`, { signal: ctrl.signal });
    const body: any = await r.json().catch(() => null);
    const url = typeof body?.result?.url === 'string' ? body.result.url : '';
    const value: TelegramWebhookProbe | null = body?.ok ? { registered: url === expected, url: url || null } : null;
    _tgWebhookCache = { at: now, value };
    return value;
  } catch (err: any) {
    logger.debug(`instance-setup: telegram webhook probe failed: ${err?.message || err}`);
    _tgWebhookCache = { at: now, value: null };
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Test seam: forget the cached getWebhookInfo answer. */
export function _resetTelegramWebhookCache() { _tgWebhookCache = null; }
