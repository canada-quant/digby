/**
 * Ghost mode (owner 2026-10-22: "private ghost mode for a session … changes
 * models to a specific new endpoint we set in admin or backend that points to
 * ablitered self hosted models") — the ADMIN DESIGNATION contract:
 *
 *   - the stored row lives in the model-roles namespace under its own key
 *   - a non-null spec must be an enabled, SERVABLE, chat-capable registry
 *     model (the whole save refuses otherwise — never a partially-updated row)
 *   - resolveGhostEndpoint is the run's truth: null + reason when
 *     unset / disabled / killed / unresolvable, the spec when live
 *   - the kill switch CHAT_GHOST_MODE_DISABLED=1 makes every read inert
 */
jest.mock('../../../utils/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../../../middleware/error-handler', () => ({
  AppError: class AppError extends Error { constructor(public statusCode: number, message: string) { super(message); } },
}));
const store: Record<string, any> = {};
jest.mock('../memory/context-store', () => ({
  storeGet: jest.fn(async (ns: string[], key: string) => store[`${ns.join(':')}/${key}`] ?? null),
  storePut: jest.fn(async (ns: string[], key: string, value: any) => { store[`${ns.join(':')}/${key}`] = value; }),
}));

import type { ModelCard } from './model-catalog';
import {
  getGhostEndpointConfig, updateGhostEndpoint, resolveGhostEndpoint, ghostSpecRefusal, clearGhostEndpointCache,
} from './ghost-endpoint.service';

const card = (spec: string, over: Partial<ModelCard> = {}): ModelCard => ({
  spec, name: spec, source: 'registry', family: 'other', tier: 'standard', vision: false, contextChars: null, maxTools: null,
  priceIn: null, priceOut: null, frontier: false, autoEligible: true, servable: true, thinkingOff: false, ...over,
});
const CATALOG: ModelCard[] = [
  card('glm-5.3', { source: 'builtin', family: 'glm' }),
  card('homelab:abliterated-llama-70b'),
  card('homelab:dolphin-mixtral', { servable: false }),
  card('homelab:embed-large', { family: 'other', autoEligible: false }),
];
const findHomelab = CATALOG.find((c) => c.spec === 'homelab:abliterated-llama-70b')!;

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  clearGhostEndpointCache();
  delete process.env.CHAT_GHOST_MODE_DISABLED;
});

describe('the refusal helper (pure)', () => {
  it('a missing catalog card is "not a chat model on this instance"; an unservable card is "not servable"; a live chat model passes', () => {
    expect(ghostSpecRefusal('homelab:missing', undefined)).toMatch(/not a chat model on this instance/);
    expect(ghostSpecRefusal('homelab:dolphin-mixtral', CATALOG.find((c) => c.spec === 'homelab:dolphin-mixtral'))).toMatch(/not servable/);
    expect(ghostSpecRefusal('homelab:abliterated-llama-70b', findHomelab)).toBeNull();
  });
});

describe('the admin designation (store-backed)', () => {
  it('saves a valid spec, stamps who, and the run reads it back', async () => {
    const saved = await updateGhostEndpoint('homelab:abliterated-llama-70b', undefined, 'admin-1', CATALOG);
    expect(saved).toMatchObject({ spec: 'homelab:abliterated-llama-70b', enabled: true, updatedBy: 'admin-1' });
    expect(store['instance:model-roles/ghost-endpoint'].spec).toBe('homelab:abliterated-llama-70b');
    expect((await getGhostEndpointConfig()).spec).toBe('homelab:abliterated-llama-70b');
    // the seats row is a DIFFERENT key — the designation never collides with it
    expect(store['instance:model-roles/config']).toBeUndefined();
  });

  it('refuses an unresolvable / unservable / non-registry spec (the whole save — no partially-updated row)', async () => {
    await expect(updateGhostEndpoint('homelab:missing', undefined, 'a', CATALOG)).rejects.toThrow(/homelab:missing.*not a chat model on this instance/);
    await expect(updateGhostEndpoint('homelab:dolphin-mixtral', undefined, 'a', CATALOG)).rejects.toThrow(/not servable/);
    await expect(updateGhostEndpoint('just-a-model-id', undefined, 'a', CATALOG)).rejects.toThrow(/"<label>:<modelId>"/);
    expect(store['instance:model-roles/ghost-endpoint']).toBeUndefined();
  });

  it('null / "" CLEARS the designation', async () => {
    await updateGhostEndpoint('homelab:abliterated-llama-70b', undefined, 'a', CATALOG);
    const cleared = await updateGhostEndpoint(null, undefined, 'a', CATALOG);
    expect(cleared).toMatchObject({ spec: null, enabled: false });
    expect((await getGhostEndpointConfig()).spec).toBeNull();
  });

  it('enabled:false keeps the spec but the run resolves nothing', async () => {
    await updateGhostEndpoint('homelab:abliterated-llama-70b', false, 'a', CATALOG);
    const config = await getGhostEndpointConfig();
    expect(config).toMatchObject({ spec: 'homelab:abliterated-llama-70b', enabled: false });
    expect(resolveGhostEndpoint(config, CATALOG)).toMatchObject({ spec: null, reason: 'disabled' });
  });
});

describe('resolveGhostEndpoint — what a run actually routes to', () => {
  it('a live designation resolves ok; unset → null/unset; a stale spec → null/unresolvable (the run keeps the normal lineup)', () => {
    expect(resolveGhostEndpoint({ spec: 'homelab:abliterated-llama-70b', enabled: true }, CATALOG)).toMatchObject({ spec: 'homelab:abliterated-llama-70b', reason: 'ok' });
    expect(resolveGhostEndpoint({ spec: null, enabled: false }, CATALOG)).toMatchObject({ spec: null, reason: 'unset' });
    expect(resolveGhostEndpoint({ spec: 'homelab:gone', enabled: true }, CATALOG)).toMatchObject({ spec: null, reason: 'unresolvable' });
  });

  it('the kill switch CHAT_GHOST_MODE_DISABLED=1 makes the designation inert (spec null, reason switch)', () => {
    process.env.CHAT_GHOST_MODE_DISABLED = '1';
    expect(resolveGhostEndpoint({ spec: 'homelab:abliterated-llama-70b', enabled: true }, CATALOG)).toMatchObject({ spec: null, reason: 'switch' });
  });
});
