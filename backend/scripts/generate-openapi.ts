/**
 * OpenAPI spec generator — scans the Express route definitions (app.ts mounts
 * + every reachable *.routes.ts) and writes backend/openapi.json.
 *
 * The scan itself lives in src/modules/openapi/openapi-scanner.ts (importable,
 * DB-free) so the drift-guard test (src/modules/openapi/openapi.test.ts) runs
 * the SAME logic — there is no second copy of the scanner.
 *
 * Usage:
 *   cd backend && npm run openapi:generate
 *   cd backend && npx tsx scripts/generate-openapi.ts
 *
 * Deterministic: no timestamps; regenerating without a route change is a
 * no-op diff. Re-run after adding/changing any route — the jest drift guard
 * fails the suite when the committed spec goes stale.
 */

import fs from 'fs';
import path from 'path';
import { buildOpenApiSpec, scanBackendRoutes } from '../src/modules/openapi/openapi-scanner';

const backendRoot = path.resolve(__dirname, '..');
const outFile = path.join(backendRoot, 'openapi.json');
const pkg = JSON.parse(fs.readFileSync(path.join(backendRoot, 'package.json'), 'utf8')) as { version: string };

const operations = scanBackendRoutes(backendRoot);
const spec = buildOpenApiSpec(pkg.version, backendRoot);

fs.writeFileSync(outFile, JSON.stringify(spec, null, 2) + '\n');

const pathCount = Object.keys(spec.paths as Record<string, unknown>).length;
const publicCount = operations.filter((o) => o.security.length === 0).length;
console.log(`✅ Wrote ${path.relative(process.cwd(), outFile)}`);
console.log(`   ${pathCount} paths, ${operations.length} operations (${publicCount} public, ${operations.length - publicCount} authenticated)`);
