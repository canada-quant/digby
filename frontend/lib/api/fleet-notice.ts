import apiClient from '../api-client';

/** The owner's fleet notice (backend platform/fleet-notice.ts) — one block every agent of this user reads. */
export interface FleetNotice {
  text: string;
  expiresAt: string;
  updatedAt: string;
  updatedBy: string;
}

export interface FleetNoticeState {
  notice: FleetNotice | null;
  active: boolean;
  disabled: boolean;
  maxChars: number;
  maxDays: number;
}

export const fleetNoticeApi = {
  get: async (): Promise<FleetNoticeState> => {
    const response = await apiClient.get('/crossmodel/fleet-notice');
    return response.data;
  },
  set: async (text: string, days: number): Promise<{ notice: FleetNotice; redacted: string[] }> => {
    const response = await apiClient.put('/crossmodel/fleet-notice', { text, days });
    return response.data;
  },
  clear: async (): Promise<void> => {
    await apiClient.delete('/crossmodel/fleet-notice');
  },
};
