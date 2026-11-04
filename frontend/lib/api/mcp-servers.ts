/**
 * User-added MCP servers API (ticket e294f9a4) — `/api/crossmodel/mcp-servers/*`.
 * Every route is the caller's OWN servers. Tokens and secret-bearing URLs are
 * write-only: responses carry `hasAuth` / `authPreview` ("••••abcd") and a
 * masked `url`, never the secret. Mirrors backend user-mcp.service.ts views.
 */

import apiClient from '../api-client';

export type McpTransportPref = 'auto' | 'streamable_http' | 'sse';
export type McpHealthStatus = 'unknown' | 'healthy' | 'degraded' | 'unhealthy';
export type McpTemplateAuthKind = 'none' | 'optional_bearer' | 'bearer' | 'header' | 'oauth';

export interface McpServerTemplate {
  id: string;
  name: string;
  description: string;
  url: string | null;
  urlRequired: boolean;
  urlHint?: string;
  transport: McpTransportPref;
  auth: { kind: McpTemplateAuthKind; headerName?: string; tokenLabel?: string; tokenHelpUrl?: string; note?: string };
  docsUrl: string;
  verifiedAt: string;
  category: string;
}

export interface McpServerHealth {
  status: McpHealthStatus;
  consecutiveFailures: number;
  lastError: string | null;
  lastErrorClass: string | null;
  lastCheckAt: string | null;
  lastOkAt: string | null;
  nextCheckAt: string | null;
  lastLatencyMs: number | null;
  transport: 'streamable_http' | 'sse' | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  toolsAt: string | null;
  toolsTruncated: boolean;
  callsOk: number;
  callsFailed: number;
  lastCallAt: string | null;
}

export interface McpServerTool {
  name: string;
  exposedName: string;
  title?: string;
  description: string;
  readOnly: boolean;
  /** 'annotation' = the server marked it read-only; 'name' = inferred from a read-verb name (the server sent no hint). */
  readOnlySource?: 'annotation' | 'name';
  destructive: boolean;
  enabled: boolean;
}

export interface McpServer {
  id: string;
  name: string;
  slug: string;
  url: string;
  transport: McpTransportPref;
  authHeader: string;
  hasAuth: boolean;
  authPreview: string | null;
  authUnreadable: boolean;
  enabled: boolean;
  machineWrites: boolean;
  templateId: string | null;
  createdAt: string;
  updatedAt: string;
  health: McpServerHealth;
  tools: McpServerTool[];
}

export interface McpProbe {
  ok: boolean;
  latencyMs: number;
  transport: string | null;
  serverName: string | null;
  serverVersion: string | null;
  protocolVersion: string | null;
  toolCount: number;
  tools: Array<{ name: string; readOnly: boolean; description: string }>;
  truncated: boolean;
  error?: string;
  errorClass?: string;
  oauth?: boolean;
}

export interface McpServerInput {
  name?: string;
  url?: string;
  transport?: McpTransportPref;
  authHeader?: string;
  /** Full header value; '' clears; omitted keeps (update). */
  authValue?: string;
  enabled?: boolean;
  machineWrites?: boolean;
  disabledTools?: string[];
  templateId?: string | null;
}

export const mcpServersApi = {
  list: async (): Promise<McpServer[]> => (await apiClient.get('/crossmodel/mcp-servers')).data.data.servers,
  templates: async (): Promise<McpServerTemplate[]> => (await apiClient.get('/crossmodel/mcp-servers/templates')).data.data.templates,
  create: async (input: McpServerInput): Promise<{ server: McpServer; probe: McpProbe | null }> =>
    (await apiClient.post('/crossmodel/mcp-servers', input)).data.data,
  testDraft: async (input: Pick<McpServerInput, 'url' | 'transport' | 'authHeader' | 'authValue'>): Promise<McpProbe> =>
    (await apiClient.post('/crossmodel/mcp-servers/test', input)).data.data.probe,
  update: async (id: string, patch: McpServerInput): Promise<{ server: McpServer; probe: McpProbe | null }> =>
    (await apiClient.patch(`/crossmodel/mcp-servers/${id}`, patch)).data.data,
  test: async (id: string): Promise<{ server: McpServer; probe: McpProbe }> =>
    (await apiClient.post(`/crossmodel/mcp-servers/${id}/test`)).data.data,
  remove: async (id: string): Promise<void> => { await apiClient.delete(`/crossmodel/mcp-servers/${id}`); },
};
