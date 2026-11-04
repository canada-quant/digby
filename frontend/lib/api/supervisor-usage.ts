/** Project / fleet cost + token usage for the supervisor side panels (backend platform/usage-rollup.ts). */
import apiClient from '../api-client';

export interface UsageWindow { usd: number; tokensIn: number; tokensOut: number }
export interface UsageDay { date: string; usd: number; tokens: number }

export interface ProjectUsage {
  projectId: string;
  today: UsageWindow; d7: UsageWindow; d30: UsageWindow;
  daily: UsageDay[];
  topChats: Array<{ chatId: string; title: string | null; usd7d: number; tokens7d: number }>;
}

export interface FleetUsage {
  today: UsageWindow; d7: UsageWindow; d30: UsageWindow;
  daily: UsageDay[];
  projects: Array<{ projectId: string | null; name: string; supervisorChatId: string | null; usdToday: number; usd7d: number; tokens7d: number }>;
}

export const supervisorUsageApi = {
  project: async (projectId: string, opts?: { signal?: AbortSignal }): Promise<ProjectUsage> =>
    (await apiClient.get(`/crossmodel/projects/${projectId}/usage`, { signal: opts?.signal })).data,
  fleet: async (opts?: { signal?: AbortSignal }): Promise<FleetUsage> =>
    (await apiClient.get('/crossmodel/fleet/usage', { signal: opts?.signal })).data,
};
