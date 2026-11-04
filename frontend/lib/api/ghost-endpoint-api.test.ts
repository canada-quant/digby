/**
 * Ghost-mode admin API (2026-10-22) — the review-D1 regression: the DEPLOYED
 * backend answers GET/PUT /admin/model-roles/ghost-endpoint with
 * `{ success, data: { config: { spec, enabled, updatedAt }, effective: {…} } }`,
 * while the frozen contract describes the flat `{ spec, enabled, updatedAt }`.
 * The client must accept BOTH (ghostEndpointViewFrom) and reject anything
 * else (older backend / partial body → the panel hides, never crashes).
 *
 * Also pins the review-D2 contract the panel relies on: ghostEndpointApi.update
 * REQUIRES `spec` (typed non-optional) because the backend treats an absent
 * spec as a CLEAR — `{ enabled }` alone would wipe the designation.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { ghostEndpointViewFrom, isGhostEndpointView, type GhostEndpointView } from '@/lib/api/model-endpoints';

/** The REAL backend shape (parent branch digby/session-836b4e7c,
 *  model-endpoints.controller.ts ghostEndpoint/updateGhostEndpoint:
 *  res.json({ success: true, data: { config, effective } })). */
const backendBody = (over: Partial<GhostEndpointView> = {}) => ({
  success: true,
  data: {
    config: {
      spec: 'homelab:abliterated-llama-70b',
      enabled: true,
      updatedAt: '2026-10-22T05:00:00.000Z',
      updatedBy: 'admin-user',
      ...over,
    },
    effective: { spec: 'homelab:abliterated-llama-70b', reason: 'ok', config: null },
  },
});

describe('ghostEndpointViewFrom — accepts BOTH response shapes', () => {
  it('unwraps the deployed backend\'s { config, effective } wrap (the review-D1 bug: this used to fail → panel null)', () => {
    const v = ghostEndpointViewFrom(backendBody().data);
    expect(v).toEqual({
      spec: 'homelab:abliterated-llama-70b',
      enabled: true,
      updatedAt: '2026-10-22T05:00:00.000Z',
    });
  });

  it('unwraps the same wrap with spec null (nothing designated)', () => {
    const v = ghostEndpointViewFrom(backendBody({ spec: null, enabled: false }).data);
    expect(v).toEqual({ spec: null, enabled: false, updatedAt: '2026-10-22T05:00:00.000Z' });
  });

  it('accepts the FLAT contract body verbatim (spec, enabled, updatedAt)', () => {
    const v = ghostEndpointViewFrom({ spec: 'mylab:model-x', enabled: false, updatedAt: '2026-10-22T06:00:00.000Z' });
    expect(v).toEqual({ spec: 'mylab:model-x', enabled: false, updatedAt: '2026-10-22T06:00:00.000Z' });
  });

  it('accepts the flat body without updatedAt (the contract marks it optional)', () => {
    expect(ghostEndpointViewFrom({ spec: null, enabled: false })).toEqual({ spec: null, enabled: false });
  });

  it('treats a legacy true/false spec as absent → null (never crashes)', () => {
    // An older/undeployed backend could answer with something else entirely —
    // the guard must degrade to "hide the panel", not throw.
    expect(ghostEndpointViewFrom({ enabled: true })).toBeNull();
    expect(ghostEndpointViewFrom({ spec: 'a:b', enabled: 'yes' })).toBeNull(); // non-boolean enabled
    expect(ghostEndpointViewFrom({ spec: 42, enabled: true })).toBeNull();     // non-string spec
    expect(ghostEndpointViewFrom(null)).toBeNull();
    expect(ghostEndpointViewFrom(undefined)).toBeNull();
    expect(ghostEndpointViewFrom('ok')).toBeNull();
    expect(ghostEndpointViewFrom({ config: 'nope' })).toBeNull();              // a bad wrap
  });

  it('isGhostEndpointView agrees with the unwrap on both shapes and rejects partials', () => {
    expect(isGhostEndpointView(backendBody().data)).toBe(true);
    expect(isGhostEndpointView({ spec: 'a:b', enabled: true })).toBe(true);
    expect(isGhostEndpointView({ effective: { spec: 'a:b' } })).toBe(false); // config absent → NOT a view
    expect(isGhostEndpointView({})).toBe(false);
  });
});

describe('ghostEndpointApi.update — the review-D2 body contract (source pins)', () => {
  const src = readFileSync(fileURLToPath(new URL('./model-endpoints.ts', import.meta.url)), 'utf-8');

  it('update REQUIRES spec (the backend clears the designation when it is absent)', () => {
    // `{ enabled }` alone would wipe the designation — spec is non-optional.
    expect(src).toContain('update: async (patch: { spec: string | null; enabled?: boolean }): Promise<GhostEndpointView> =>');
    expect(src).toContain('a body WITHOUT `spec` CLEARS it');
  });

  it('get/update unwrap through ghostEndpointViewFrom and throw on an unrecognized body', () => {
    expect(src.match(/ghostEndpointViewFrom\(response\.data\?\.data\)/g)?.length).toBe(2);
  });
});
