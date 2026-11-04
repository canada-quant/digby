/**
 * Asana MCP Client
 *
 * Calls the asana-mcp Docker container via JSON-RPC 2.0 / MCP Streamable HTTP.
 * Passes the user's (auto-refreshed) Asana access token via the X-Asana-Token header.
 *
 * The Asana MCP container runs at http://asana-mcp-prod:8000 (Docker network).
 * It validates X-API-Key then forwards X-Asana-Token to the inner MCP server.
 *
 * Returns formatted context strings. READS surface a failed call as ONE readable
 * line (2026-10-04, integrations/integration-error.ts): the Asana connection
 * needs re-authorizing / rate-limited / Asana down / the asana-mcp connector did
 * not answer / not configured — instead of '' (which the coding executor turned
 * into "No result from Asana … may not be connected … or nothing matched").
 * Not-connected and genuinely-empty results keep the '' contract; WRITES keep
 * returning the raw MCP text or null. INTEGRATION_ERROR_SURFACE_DISABLED=1
 * restores the old silent '' for reads.
 */

import axios from 'axios';
import logger from '../../../utils/logger';
import { getValidToken, hasAsanaConnected } from './token-manager';
import {
  IntegrationApiError, INTEGRATION_SERVICES, integrationErrorSurfaceDisabled, surfacedOrEmpty,
  connectorTransportError, mcpOperationLabel, isErrorShapedText, classifyUpstreamErrorText, stripErrorPrefix,
} from '../integrations/integration-error';

const SERVICE = INTEGRATION_SERVICES.asana;
/** Reads run strict (a failure throws IntegrationApiError) unless the kill switch is set. */
const strictRead = () => !integrationErrorSurfaceDisabled();

const ASANA_MCP_URL     = process.env.ASANA_MCP_URL || 'http://asana-mcp-prod:8000/mcp';
const ASANA_MCP_API_KEY = process.env.ASANA_MCP_API_KEY;

// ── Core MCP call (SSE streaming response) ────────────────────────────────────

/**
 * `strict` (reads only): every failure THROWS an IntegrationApiError instead of
 * returning null — a connector transport failure (gateway), a JSON-RPC error,
 * a missing server key (not_configured), a connected user whose token is
 * unusable (no_token), and a provider error the container returned as
 * "Error …" text that classifies as auth / rate-limited / down. Non-strict
 * (writes, and reads under the kill switch) is byte-identical to before.
 */
async function callAsanaMcpTool(
  userId: string,
  toolName: string,
  params: Record<string, unknown>,
  strict = false,
): Promise<string | null> {
  const op = mcpOperationLabel(toolName, 'asana_');
  if (!ASANA_MCP_API_KEY) {
    logger.warn(`Asana MCP: ASANA_MCP_API_KEY not set, skipping ${toolName}`);
    if (strict) throw new IntegrationApiError(SERVICE, op, 'not_configured', null, 'ASANA_MCP_API_KEY unset');
    return null;
  }

  const token = await getValidToken(userId);
  if (!token) {
    logger.warn(`Asana MCP: no token for userId=${userId}, skipping ${toolName}`);
    // A stored connection whose token cannot be used is a failure; no row at all is "not connected" ('' as before).
    if (strict && await Promise.resolve().then(() => hasAsanaConnected(userId)).catch(() => false)) {
      throw new IntegrationApiError(SERVICE, op, 'no_token', null, '');
    }
    return null;
  }

  const requestId = Date.now() + Math.floor(Math.random() * 10000);

  try {
    const response = await axios.post(
      ASANA_MCP_URL,
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
          'X-API-Key':     ASANA_MCP_API_KEY,
          'X-Asana-Token': token,
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
          reject(new Error(`Asana MCP ${toolName} timed out`));
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
            // line; anything else (an unknown workspace / task id …) stays the container's own words.
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
    logger.warn(`Asana MCP ${toolName} failed: ${error.message}`);
    if (strict) throw connectorTransportError(SERVICE, op, error);
    return null;
  }
}

// ── Public tool functions ─────────────────────────────────────────────────────

/** WRITES (capability gap #26, 2026-09-24): raw MCP text or null — the executor builds the envelope. */
export async function createTask(userId: string, input: { name: string; notes?: string; project?: string; workspace?: string; dueOn?: string; assignee?: string }): Promise<string | null> {
  return callAsanaMcpTool(userId, 'asana_create_task', { ...input });
}
export async function updateTask(userId: string, taskId: string, input: { name?: string; notes?: string; completed?: boolean; dueOn?: string | null }): Promise<string | null> {
  return callAsanaMcpTool(userId, 'asana_update_task', { taskId, ...input });
}

export async function listMyTasks(userId: string): Promise<string> {
  try {
    const result = await callAsanaMcpTool(userId, 'asana_list_my_tasks', {}, strictRead());
    if (!result) return '';
    return `[Asana — My Tasks]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listProjects(userId: string): Promise<string> {
  try {
    const result = await callAsanaMcpTool(userId, 'asana_list_projects', {}, strictRead());
    if (!result) return '';
    return `[Asana — Projects]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function searchTasks(userId: string, text: string): Promise<string> {
  try {
    const result = await callAsanaMcpTool(userId, 'asana_search_tasks', { text }, strictRead());
    if (!result) return '';
    return `[Asana — Task Search]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function listWorkspaces(userId: string): Promise<string> {
  try {
    const result = await callAsanaMcpTool(userId, 'asana_list_workspaces', {}, strictRead());
    if (!result) return '';
    return `[Asana — Workspaces]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}

export async function getUser(userId: string): Promise<string> {
  try {
    const result = await callAsanaMcpTool(userId, 'asana_get_user', {}, strictRead());
    if (!result) return '';
    return `[Asana — User]\n${result}`;
  } catch (err) { return surfacedOrEmpty(err); }
}
