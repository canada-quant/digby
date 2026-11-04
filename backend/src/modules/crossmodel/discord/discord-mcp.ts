/**
 * Discord MCP Client (ticket c0e2769b)
 *
 * Calls the discord-mcp Docker container via JSON-RPC 2.0 / MCP Streamable HTTP.
 * Unlike Slack's per-user OAuth, Discord bots use ONE shared bot token that
 * lives in the container's env (DISCORD_BOT_TOKEN) — the backend sends only
 * the shared X-API-Key secret, never a per-user token.
 *
 * The discord-mcp container runs at http://discord-mcp-prod:8000 (Docker
 * network). It validates X-API-Key, then uses its env bot token.
 *
 * Returns formatted context strings. READS surface a failed call as ONE
 * readable line (mirroring slack-mcp, 2026-10-04): the Discord bot token
 * needs re-issuing / rate-limited / Discord down / the discord-mcp connector
 * did not answer / not configured. Not-connected and genuinely-empty results
 * keep the '' contract; WRITES keep returning the raw MCP text or null.
 * INTEGRATION_ERROR_SURFACE_DISABLED=1 restores the old silent '' for reads.
 *
 * Read health (ticket fa956f09 class): READ outcomes latch the platform
 * IntegrationHealth row — a shared bot token is a PLATFORM credential (never
 * per-user), so every read failure is platform-side.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { recordReadOutcome } from '../integration-health';
import {
  IntegrationApiError, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled, surfacedOrEmpty,
  connectorTransportError, mcpOperationLabel, isErrorShapedText, classifyUpstreamErrorText, stripErrorPrefix,
} from '../integrations/integration-error';

const SERVICE = INTEGRATION_SERVICES.discord;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();

const DISCORD_MCP_URL     = process.env.DISCORD_MCP_URL || 'http://discord-mcp-prod:8000/mcp';
const DISCORD_MCP_API_KEY = process.env.DISCORD_MCP_API_KEY;

let nextRequestId = 1;

/**
 * `strict` (reads only): every failure THROWS an IntegrationApiError instead of
 * returning null — a connector transport failure (gateway), a JSON-RPC error, a
 * missing server key (not_configured), and a provider error the container
 * returned as text. Non-strict (writes, and reads under the kill switch)
 * returns null.
 *
 * `readHealth` (ticket fa956f09 class — the x-mcp contract): READ tools set it
 * and EVERY outcome latches the platform IntegrationHealth row BEFORE any
 * return or throw — ok on success, false on each failure path (missing key,
 * empty payload, JSON-RPC error, non-string content, empty content string,
 * error-shaped provider text, network throw). Health recording is NEVER gated
 * on `strict` (defect c0e2769b: the strict path — the default for every read —
 * never latched anything, so a dead read path kept the UI "connected+healthy").
 * Write tools leave it unset (writes measure auth, not the platform read
 * path) — a write failure must never pollute the read-health row.
 */
async function callDiscordMcpTool(
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
  opts: { readHealth?: boolean } = {},
): Promise<string | null> {
  const op = mcpOperationLabel(toolName, 'discord_');
  // fa956f09: record (ok AND failure) on every read outcome, unconditionally,
  // before any return/throw. Returns a never-rejecting promise so callers
  // `await` it (test-deterministic) without a health-row hiccup failing the
  // read itself; the failure's reason text is preserved.
  const record = (ok: boolean, reason?: string): Promise<void> =>
    opts.readHealth ? recordReadOutcome('discord', ok, reason).catch(() => {}) : Promise.resolve();

  if (!DISCORD_MCP_API_KEY) {
    logger.warn(`Discord MCP: DISCORD_MCP_API_KEY not set, returning null for ${toolName}`);
    await record(false, 'DISCORD_MCP_API_KEY not configured');
    if (strict) throw new IntegrationApiError(SERVICE, op, 'not_configured', null, 'DISCORD_MCP_API_KEY unset');
    return null;
  }

  try {
    const response = await axios.post(
      DISCORD_MCP_URL,
      {
        jsonrpc: '2.0',
        id: nextRequestId++,
        method: 'tools/call',
        params: { name: toolName, arguments: params },
      },
      {
        headers: {
          'X-API-Key': DISCORD_MCP_API_KEY,
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
        },
        timeout: 120000,
        responseType: 'text',
        transformResponse: (r) => r,
        validateStatus: (s) => s < 500,
      },
    );

    const body = response.data as string;
    const jsonPayload = body.startsWith('{')
      ? body
      : (body.split('\n')
            .map((l) => l.trim())
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice(5).trim())
            .filter((l) => l && l !== '[DONE]')
            .at(-1)) || '';

    if (!jsonPayload) {
      logger.warn(`discord-mcp tool ${toolName} returned an empty payload (gateway/SSE failure)`);
      await record(false, `discord-mcp ${toolName}: empty payload from gateway`);
      if (strict) throw connectorTransportError(SERVICE, op, new Error('empty payload from gateway'));
      return null;
    }
    const parsed = JSON.parse(jsonPayload);
    if (parsed.error) {
      const errDesc = `discord-mcp ${toolName} error: ${JSON.stringify(parsed.error).slice(0, 400)}`;
      logger.warn(errDesc);
      await record(false, errDesc);
      if (strict) throw new IntegrationApiError(SERVICE, op, 'down', null, errDesc);
      return null;
    }
    const text = parsed.result?.content?.[0]?.text;
    if (typeof text !== 'string') {
      logger.warn(`discord-mcp tool ${toolName} returned non-string content: ${JSON.stringify(parsed.result?.content).slice(0, 200)}`);
      await record(false, `discord-mcp ${toolName}: non-string content part`);
      if (strict) throw connectorTransportError(SERVICE, op, new Error('non-string content part'));
      return null;
    }
    // An empty content STRING is no-data to every caller ('' is falsy at each
    // consumption seam) — the health row must not call it ok (fa956f09 class).
    // x-mcp parity: record false and return null on BOTH paths — the old
    // strict-path "genuinely empty is data" return was the c0e2769b
    // inconsistency.
    if (!text.trim()) {
      logger.warn(`discord-mcp tool ${toolName} returned an empty content string (no data)`);
      await record(false, `discord-mcp ${toolName}: empty content string`);
      return null;
    }
    // The container answers a provider failure as "Error <fn>: <reason>" TEXT
    // (slack-mcp parity, 2026-10-04): an actionable class (auth / rate limit /
    // provider down) is a read-path failure — record false and surface the
    // standard line. A non-actionable container error (e.g. channel_not_found)
    // is the container answering correctly: it passes through as data.
    if (isErrorShapedText(text)) {
      const kind = classifyUpstreamErrorText(text);
      if (kind) {
        const desc = stripErrorPrefix(text);
        const reason = `discord-mcp ${toolName}: ${kind} (${desc.slice(0, 200)})`;
        logger.warn(reason);
        await record(false, reason);
        if (strict) throw new IntegrationApiError(SERVICE, op, kind, null, desc);
        return null;
      }
    }
    await record(true);
    return text;
  } catch (err: any) {
    // A strict-path throw above (empty payload / error body / non-string part /
    // classified upstream error) already recorded its outcome AT THE THROW SITE
    // — the c0e2769b fix. Re-recording it here would double-count one failed
    // read as two health rows. connectorTransportError passes an
    // IntegrationApiError through unchanged, so instanceof discriminates our own
    // already-recorded throws from genuinely new catch-path failures (axios /
    // JSON.parse), which are the only ones that record here.
    if (err instanceof IntegrationApiError) {
      if (strict) throw err;
      return null;
    }
    const msg = `discord-mcp call ${toolName} failed: ${err.message}`;
    logger.warn(msg);
    await record(false, msg);
    if (strict) throw connectorTransportError(SERVICE, op, err);
    return null;
  }
}

// ── Public tool functions ─────────────────────────────────────────────────────

/** WRITE: send a message to a channel as the bot. Returns the raw MCP text (or null when not connected / call failed) — the executor builds the envelope. */
export async function sendMessage(channelId: string, content: string, replyTo?: string): Promise<string | null> {
  return callDiscordMcpTool('discord_send_message', { channelId, content, ...(replyTo ? { replyTo } : {}) });
}

/** WRITE: DM a user as the bot. Returns the raw MCP text (or null). */
export async function sendDm(userId: string, content: string): Promise<string | null> {
  return callDiscordMcpTool('discord_send_dm', { userId, content });
}

export async function getBotInfo(): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_get_bot_info', {}, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord Bot]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listGuilds(limit = 50): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_list_guilds', { limit }, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord Servers]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listChannels(guildId: string): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_list_channels', { guildId }, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord Channels: ${guildId}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getChannelHistory(channelId: string, limit = 20, before?: string): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_channel_history', { channelId, limit, ...(before ? { before } : {}) }, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord Channel History: ${channelId}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listDms(): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_list_dms', {}, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord DMs]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function scrapeChannel(channelId: string, maxMessages = 500, before?: string): Promise<string> {
  try {
    const result = await callDiscordMcpTool('discord_scrape_channel', { channelId, maxMessages, ...(before ? { before } : {}) }, strictRead(), { readHealth: true });
    if (!result) return '';
    return `[Discord Channel Scrape: ${channelId}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

/**
 * Health probe for the connector status surface: does the container answer a
 * cheap read? Mirrors the slack/x health probe contract (true = reachable).
 */
export async function probeHealth(): Promise<boolean> {
  try {
    const result = await callDiscordMcpTool('discord_get_bot_info', {}, false);
    return result !== null;
  } catch { return false; }
}
