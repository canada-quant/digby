import apiClient from '../api-client';

// Digby Kids — parent-side management of child sub-accounts.

export interface ChildAccount {
  id: string;
  name: string;
  email: string;
  age: number | null;
  guardrails: string;
  createdAt: string;
}

export interface CreateChildInput {
  name: string;
  email: string;
  password: string;
  age: number;
  guardrails?: string;
  parentPin: string;
}

export const childrenApi = {
  async list(): Promise<{ children: ChildAccount[]; pinSet: boolean }> {
    const res = await apiClient.get('/crossmodel/children');
    return res.data.data;
  },

  async create(input: CreateChildInput): Promise<ChildAccount> {
    const res = await apiClient.post('/crossmodel/children', input);
    return res.data.data;
  },

  async update(
    id: string,
    patch: { age?: number; guardrails?: string; password?: string; parentPin: string },
  ): Promise<ChildAccount> {
    const res = await apiClient.patch(`/crossmodel/children/${id}`, patch);
    return res.data.data;
  },

  async remove(id: string, parentPin: string): Promise<void> {
    await apiClient.delete(`/crossmodel/children/${id}`, { data: { parentPin } });
  },

  /** Verify the parent PIN. Works from a parent OR a child session. */
  async verifyParentPin(pin: string): Promise<boolean> {
    const res = await apiClient.post('/crossmodel/children/verify-parent-pin', { pin });
    return Boolean(res.data?.data?.valid);
  },
};
