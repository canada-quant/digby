/**
 * Account → Admin → Users & traffic — API client (owner 2026-10-07). Admin-only reads of the first-party visitor
 * analytics (backend/src/modules/crossmodel/visitors/visitor-analytics.service.ts). Never a raw IP: `ipHash` is the
 * first 8 chars of an HMAC hash.
 */
import apiClient from '../api-client';

export interface TrafficChannelRow {
  channel: string;
  label: string;
  paid: boolean;
  visitors: number;
  guestChatters: number;
  signups: number;
  activated: number;
  d7Eligible: number;
  retainedD7: number;
  costUsd: number;
}
export interface TrafficCampaignRow extends TrafficChannelRow { campaign: string }
export interface TrafficFunnelRow {
  channel: string;
  label: string;
  landed: number;
  signedUp: number;
  firstChat: number;
  d7Eligible: number;
  d7Active: number;
  guestChatted: number;
}
export interface TrafficSources {
  from: string;
  to: string;
  captureEnabled: boolean;
  totals: Omit<TrafficChannelRow, 'channel' | 'label' | 'paid'>;
  channels: TrafficChannelRow[];
  campaigns: TrafficCampaignRow[];
  funnel: TrafficFunnelRow[];
  spendByKind: Array<{ kind: string; usd: number }>;
  topPaths: Array<{ path: string; views: number; visitors: number }>;
  topLandings: Array<{ path: string; visitors: number }>;
}

export interface TrafficUserRow {
  kind: 'user' | 'visitor';
  id: string;
  label: string;
  channel: string;
  channelLabel: string;
  campaign: string | null;
  signedUpAt: string | null;
  lastActiveAt: string | null;
  chats7: number;
  chats30: number;
  msgs7: number;
  msgs30: number;
  cost1: number;
  cost7: number;
  cost30: number;
  costAll: number;
  ipHash: string | null;
  device: string | null;
}
export type TrafficUserSort = 'label' | 'channel' | 'signedUp' | 'lastActive' | 'chats7' | 'chats30' | 'msgs7' | 'msgs30' | 'cost1' | 'cost7' | 'cost30' | 'costAll';
export interface TrafficUsersPage {
  rows: TrafficUserRow[];
  total: number;
  page: number;
  pageSize: number;
  sort: TrafficUserSort;
  dir: 'asc' | 'desc';
}
export interface TrafficUsersQuery {
  q?: string;
  sort?: TrafficUserSort;
  dir?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
  kind?: 'all' | 'users' | 'visitors';
  channel?: string;
}

export interface TrafficFlowItem {
  at: string;
  kind: 'landing' | 'event' | 'signup' | 'first_chat' | 'chat_day' | 'coding_session';
  type: string;
  path?: string | null;
  source?: 'client' | 'server' | 'db';
  detail?: Record<string, unknown> | null;
}
export interface TrafficFlowVisitor {
  id: string;
  ipHash: string | null;
  device: string | null;
  channel: string;
  channelLabel: string;
  campaign: string | null;
  firstSeen: string | null;
  lastSeen: string | null;
  firstTouch: Record<string, unknown> | null;
  lastTouch: Record<string, unknown> | null;
  isBot: boolean;
}
export interface TrafficFlow {
  subject: { kind: 'user' | 'visitor'; id: string; label: string; signedUpAt: string | null; linkedUserIds?: string[] };
  attribution: { channel: string; channelLabel: string; campaign: string | null; firstTouch: Record<string, unknown> | null } | null;
  visitors: TrafficFlowVisitor[];
  cost: { cost1: number; cost7: number; cost30: number; costAll: number };
  items: TrafficFlowItem[];
  truncated: boolean;
}

export const trafficApi = {
  /** Channels / campaigns / funnel / paths for a YYYY-MM-DD range (to inclusive). */
  sources: async (from: string, to: string): Promise<TrafficSources> => {
    const response = await apiClient.get('/crossmodel/admin/traffic/sources', { params: { from, to } });
    return response.data.data;
  },
  /** The server-side sorted / searched / paginated users + visitors table. */
  users: async (query: TrafficUsersQuery): Promise<TrafficUsersPage> => {
    const response = await apiClient.get('/crossmodel/admin/traffic/users', { params: query });
    return response.data.data;
  },
  /** One subject's timeline (a user id or a visitor id). */
  flow: async (subject: { userId: string } | { visitorId: string }): Promise<TrafficFlow> => {
    const response = await apiClient.get('/crossmodel/admin/traffic/flow', { params: subject });
    return response.data.data;
  },
};
