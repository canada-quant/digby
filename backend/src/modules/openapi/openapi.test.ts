/**
 * OpenAPI drift guard — runs the SAME scanner as the generator
 * (scripts/generate-openapi.ts → src/modules/openapi/openapi-scanner.ts) and
 * asserts the committed backend/openapi.json matches the live route surface
 * exactly, in both directions:
 *
 *   - every discovered route exists in the spec (no missing routes), and
 *   - every spec path+method is discoverable (no phantom/stale entries).
 *
 * Fails the suite when someone adds/changes a route without regenerating.
 * Fix: `cd backend && npm run openapi:generate` and commit the diff.
 */

import fs from 'fs';
import path from 'path';
import { scanBackendRoutes } from './openapi-scanner';

const backendRoot = path.resolve(__dirname, '..', '..', '..');
const specFile = path.join(backendRoot, 'openapi.json');

interface SpecShape {
  paths: Record<string, Record<string, unknown>>;
}

describe('OpenAPI drift guard', () => {
  const discovered = scanBackendRoutes(backendRoot);
  const discoveredKeys = new Set(discovered.map((o) => `${o.method} ${o.path}`));

  it('discovers a sane route surface', () => {
    // Smoke: the major families must be present (auth, crossmodel, platform).
    expect(discovered.length).toBeGreaterThan(100);
    expect(discoveredKeys.has('post /api/auth/login')).toBe(true);
    expect(discoveredKeys.has('get /api/crossmodel/chats')).toBe(true);
    expect(discoveredKeys.has('get /api/crossmodel/platform/chats')).toBe(true);
    expect(discoveredKeys.has('get /api/health')).toBe(true);
  });

  it('committed openapi.json exists', () => {
    expect(fs.existsSync(specFile)).toBe(true);
  });

  describe('against committed openapi.json', () => {
    let specKeys: Set<string>;
    beforeAll(() => {
      const spec = JSON.parse(fs.readFileSync(specFile, 'utf8')) as SpecShape;
      specKeys = new Set(
        Object.entries(spec.paths).flatMap(([p, item]) => Object.keys(item).map((m) => `${m} ${p}`))
      );
    });

    it('has no missing routes (every discovered route is documented)', () => {
      const missing = [...discoveredKeys].filter((k) => !specKeys.has(k)).sort();
      expect(missing).toEqual([]);
    });

    it('has no phantom routes (every documented route still exists)', () => {
      const phantom = [...specKeys].filter((k) => !discoveredKeys.has(k)).sort();
      expect(phantom).toEqual([]);
    });
  });
});
