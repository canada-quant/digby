/**
 * Branding-pack admin API (todo 61dc8aaf, Phase 2 Cloud).
 *
 * Mirrors the backend surface in
 * `backend/src/modules/crossmodel/branding/branding-pack.routes.ts`:
 *
 *   GET    /crossmodel/admin/branding/packs            list + slots/limits
 *   POST   /crossmodel/admin/branding/packs            create (multipart)
 *   POST   /crossmodel/admin/branding/packs/:id/activate
 *   POST   /crossmodel/admin/branding/packs/rollback   back to shipped Digby
 *   DELETE /crossmodel/admin/branding/packs/:id
 *
 * The CREATE call is raw `fetch` + `FormData` rather than `apiClient`, for the
 * same reason `uploadToProject` is: `apiClient` is an axios instance created with
 * a JSON `Content-Type`, and a multipart body needs the browser to set
 * `multipart/form-data; boundary=…` itself. Setting it by hand (or inheriting the
 * JSON default) breaks multer's parse. Every other call goes through `apiClient`
 * so it inherits the 401 → refresh → retry interceptor.
 */

import apiClient from '@/lib/api-client';

export type PackStatus = 'draft' | 'active' | 'archived';

export interface BrandingPackAsset {
  slot: string;
  mimeType: string;
  width: number | null;
  height: number | null;
  sha256: string;
  sizeBytes: number;
}

export interface BrandingPackManifest {
  name: string;
  shortName: string;
  tagline: string;
  description: string;
  logoAlt: string;
  titleSuffix: string;
  theme: { light: string; dark: string; backgroundLight: string; backgroundDark: string };
}

export interface BrandingPack {
  id: string;
  name: string;
  description: string | null;
  status: PackStatus;
  manifest: BrandingPackManifest;
  assets: BrandingPackAsset[];
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

export interface BrandingPacksList {
  packs: BrandingPack[];
  activePackId: string | null;
  slots: string[];
  limits: Record<string, number>;
  maxAssetBytes: number;
}

/** The rejection shape a 400 from the create route carries (one per bad slot). */
export interface PackRejection {
  slot: string;
  reason: string;
}

/** Human labels for the slots — the admin panel names each upload target. */
export const SLOT_LABELS: Record<string, string> = {
  logo: 'Logo (full)',
  logoCompact: 'Logo (compact)',
  logoLight: 'Logo — light mode',
  logoDark: 'Logo — dark mode',
  spinner: 'Spinner (animated)',
  spinnerStatic: 'Spinner — static twin (reduced motion)',
  favicon16: 'Favicon 16px',
  favicon32: 'Favicon 32px',
  icon192: 'App icon 192px',
  icon512: 'App icon 512px',
  appleTouchIcon: 'Apple touch icon',
};

/** Slots whose absence blocks activation (mirrors `missingForActivation`). */
export function missingForActivation(slots: string[]): string[] {
  const have = new Set(slots);
  const missing: string[] = [];
  if (!have.has('logo') && !have.has('logoLight') && !have.has('logoDark')) missing.push('logo');
  if (have.has('spinner') && !have.has('spinnerStatic')) missing.push('spinnerStatic');
  return missing;
}

/** The public URL of one asset of an ACTIVE pack — what the preview shows. */
export function packAssetUrl(packId: string, slot: string): string {
  return `/api/crossmodel/branding/pack/${encodeURIComponent(packId)}/asset/${encodeURIComponent(slot)}`;
}

function apiBase(): string {
  return process.env.NEXT_PUBLIC_API_URL || 'http://localhost:4000/api';
}

function authToken(): string | null {
  return typeof window !== 'undefined' ? localStorage.getItem('accessToken') : null;
}

export const brandingPacksApi = {
  list: async (): Promise<BrandingPacksList> => {
    const res = await apiClient.get('/crossmodel/admin/branding/packs');
    return res.data.data;
  },

  /**
   * Create a draft pack. `files` maps a slot → File; every file is validated by
   * the backend before ANY row is written, so a 400 here means nothing was saved.
   */
  create: async (input: {
    name: string;
    description?: string;
    manifest: Partial<BrandingPackManifest>;
    files: Partial<Record<string, File>>;
  }): Promise<BrandingPack> => {
    const form = new FormData();
    form.append('name', input.name);
    if (input.description) form.append('description', input.description);
    form.append('manifest', JSON.stringify(input.manifest));
    for (const [slot, file] of Object.entries(input.files)) {
      if (file) form.append(slot, file);
    }
    const token = authToken();
    const res = await fetch(`${apiBase()}/crossmodel/admin/branding/packs`, {
      method: 'POST',
      // NO Content-Type — the browser must set the multipart boundary.
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      body: form,
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      const error = new Error(body?.error || `Upload failed (${res.status})`) as Error & {
        rejections?: PackRejection[];
      };
      error.rejections = body?.rejections;
      throw error;
    }
    return body.data.pack;
  },

  activate: async (packId: string): Promise<BrandingPack> => {
    const res = await apiClient.post(`/crossmodel/admin/branding/packs/${encodeURIComponent(packId)}/activate`);
    return res.data.data.pack;
  },

  rollback: async (): Promise<{ rolledBack: number }> => {
    const res = await apiClient.post('/crossmodel/admin/branding/packs/rollback');
    return res.data.data;
  },

  remove: async (packId: string): Promise<{ deleted: boolean }> => {
    const res = await apiClient.delete(`/crossmodel/admin/branding/packs/${encodeURIComponent(packId)}`);
    return res.data.data;
  },
};