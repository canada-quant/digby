/**
 * Slack MCP Client
 *
 * Calls the slack-mcp Docker container via JSON-RPC 2.0 / MCP Streamable HTTP.
 * Passes the user's Slack user token via the X-Slack-Token header.
 *
 * The Slack MCP container runs at http://slack-mcp-prod:8000 (Docker network).
 * It validates X-API-Key then forwards X-Slack-Token to the inner MCP server.
 *
 * Returns formatted context strings. READS surface a failed call as ONE readable
 * line (2026-10-04, integrations/integration-error.ts): the Slack connection
 * needs re-authorizing / rate-limited / Slack down / the slack-mcp connector did
 * not answer / not configured — instead of '' (which the coding executor turned
 * into "No result from Slack … may not be connected … or nothing matched").
 * Not-connected and genuinely-empty results keep the '' contract; WRITES keep
 * returning the raw MCP text or null. INTEGRATION_ERROR_SURFACE_DISABLED=1
 * restores the old silent '' for reads.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getValidToken, hasSlackConnected } from './token-manager';
import {
  IntegrationApiError, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled, surfacedOrEmpty,
  connectorTransportError, mcpOperationLabel, isErrorShapedText, classifyUpstreamErrorText, stripErrorPrefix,
} from '../integrations/integration-error';

const SERVICE = INTEGRATION_SERVICES.slack;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();

const SLACK_MCP_URL     = process.env.SLACK_MCP_URL || 'http://slack-mcp-prod:8000/mcp';
const SLACK_MCP_API_KEY = process.env.SLACK_MCP_API_KEY;

// ── Core MCP call (SSE streaming response) ────────────────────────────────────

/**
 * `strict` (reads only): every failure THROWS an IntegrationApiError instead of
 * returning null — a connector transport failure (gateway), a JSON-RPC error,
 * a missing server key (not_configured), a connected user whose token is
 * unusable (no_token), and a provider error the container returned as
 * "Error …" text that classifies as auth / rate-limited / down. Non-strict
 * (writes, and reads under the kill switch) is byte-identical to before.
 */
async function callSlackMcpTool(
  userId: string,
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
): Promise<string | null> {
  const op = mcpOperationLabel(toolName, 'slack_');
  if (!SLACK_MCP_API_KEY) {
    logger.warn(`Slack MCP: SLACK_MCP_API_KEY not set, skipping ${toolName}`);
    if (strict) throw new IntegrationApiError(SERVICE, op, 'not_configured', null, 'SLACK_MCP_API_KEY unset');
    return null;
  }

  const token = await getValidToken(userId);
  if (!token) {
    logger.warn(`Slack MCP: no token for userId=${userId}, skipping ${toolName}`);
    // A stored connection whose token cannot be used is a failure; no row at all is "not connected" ('' as before).
    if (strict && await Promise.resolve().then(() => hasSlackConnected(userId)).catch(() => false)) {
      throw new IntegrationApiError(SERVICE, op, 'no_token', null, '');
    }
    return null;
  }

  const requestId = Date.now() + Math.floor(Math.random() * 10000);

  try {
    const response = await axios.post(
      SLACK_MCP_URL,
      {
        jsonrpc: '2.0',
        method:  'tools/call',
        params:  { name: toolName, arguments: params },
        id:      requestId,
      },
      {
        headers: {
          'Content-Type':  'application/json',
          'Accept':        'application/json, text/event-stream',
          'X-API-Key':     SLACK_MCP_API_KEY,
          'X-Slack-Token': token,
        },
        timeout:      25000,
        responseType: 'stream',
      }
    );

    return await new Promise<string | null>((resolve, reject) => {
      const stream = response.data;
      let buffer   = '';
      let resolved = false;

      const safetyTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          stream.destroy();
          reject(new Error(`Slack MCP ${toolName} timed out`));
        }
      }, 25000);

      stream.on('data', (chunk: Buffer) => {
        if (resolved) return;
        buffer += chunk.toString();

        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith('data:')) continue;
          const rawJson = trimmed.slice(5).trim();
          if (!rawJson || rawJson === '[DONE]') continue;

          try {
            const parsed = JSON.parse(rawJson);
            if (parsed.id !== requestId) continue;

            resolved = true;
            clearTimeout(safetyTimer);
            stream.destroy();

            if (parsed.error) {
              reject(strict
                ? new IntegrationApiError(SERVICE, op, 'other', null, `MCP error: ${parsed.error.message || 'unknown'}`)
                : new Error(parsed.error.message || 'MCP error'));
              return;
            }

            const content = parsed.result?.content;
            if (!content || !Array.isArray(content)) { resolve(null); return; }
            const text = content.find((c: any) => c.type === 'text')?.text || null;
            // The container answers a provider error as "Error <fn>: <reason>" text. An
            // actionable class (auth / rate limit / provider down) becomes the standard
            // line; anything else (channel_not_found …) stays the container's own words.
            if (strict && isErrorShapedText(text)) {
              const kind = classifyUpstreamErrorText(text as string);
              if (kind) { reject(new IntegrationApiError(SERVICE, op, kind, null, stripErrorPrefix(text as string))); return; }
            }
            resolve(text);
          } catch { /* skip non-JSON SSE lines */ }
        }
      });

      stream.on('error', (err: Error) => {
        if (!resolved) { resolved = true; clearTimeout(safetyTimer); reject(err); }
      });

      stream.on('end', () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(safetyTimer);
          reject(new Error(`SSE stream ended without response for ${toolName}`));
        }
      });
    });
  } catch (error: any) {
    logger.warn(`Slack MCP ${toolName} failed: ${error.message}`);
    if (strict) throw connectorTransportError(SERVICE, op, error);
    return null;
  }
}

// ── Public tool functions ─────────────────────────────────────────────────────

/** WRITE (capability gap #26, 2026-09-24): post as the user. Returns the raw MCP text (or null when not connected / call failed) — the executor builds the envelope. */
export async function postMessage(userId: string, channel: string, text: string, threadTs?: string): Promise<string | null> {
  return callSlackMcpTool(userId, 'slack_post_message', { channel, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
}

export async function listChannels(userId: string, limit = 50, types?: string): Promise<string> {
  try {
    const result = await callSlackMcpTool(
      userId,
      'slack_list_channels',
      // Ticket 24541fb3: default to ALL conversation types — a DM-blind listing
      // (channels only) made DMs/group-DMs undiscoverable even after the
      // im/mpim history scopes landed: the agent could read a DM by raw ID but
      // no tool could ever name one. Types are the Slack API's own enum values.
      { limit, types: types ?? 'public_channel,private_channel,im,mpim' },
      strictRead(),
    );
    if (!result) return '';
    return `[Slack Channels]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getChannelHistory(userId: string, channel: string, limit = 20): Promise<string> {
  try {
    const result = await callSlackMcpTool(userId, 'slack_channel_history', { channel, limit }, strictRead());
    if (!result) return '';
    return `[Slack Channel History: ${channel}]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function searchMessages(userId: string, query: string, count = 20): Promise<string> {
  try {
    const result = await callSlackMcpTool(userId, 'slack_search_messages', { query, count }, strictRead());
    if (!result) return '';
    return `[Slack Search Results]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listUsers(userId: string, limit = 50): Promise<string> {
  try {
    const result = await callSlackMcpTool(userId, 'slack_list_users', { limit }, strictRead());
    if (!result) return '';
    return `[Slack Users]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getAuth(userId: string): Promise<string> {
  try {
    const result = await callSlackMcpTool(userId, 'slack_get_auth', {}, strictRead());
    if (!result) return '';
    return `[Slack Identity]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}
