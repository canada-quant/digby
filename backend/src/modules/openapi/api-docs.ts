/**
 * OpenAPI serving — PUBLIC (no auth) documentation surface:
 *
 *   GET /api/openapi.json — the committed, generated spec (see
 *     backend/scripts/generate-openapi.ts). Served from disk, read once and
 *     cached for the process lifetime (the file only changes on deploy).
 *     404s with a clear remediation message when the spec was never generated.
 *   /api/docs(+/) and /api-docs(+/) — Swagger UI (swagger-ui-express, already a dependency)
 *     pointed at /api/openapi.json.
 *
 * The spec is route metadata only (methods, paths, auth posture) — no secrets.
 *
 * CSP: the global helmet policy's `script-src 'self'` would block the inline
 * bootstrap script swagger-ui-express injects into its HTML. A scoped helmet
 * instance INSIDE this router re-sets the CSP for those paths only, adding
 * 'unsafe-inline' to script-src — the global policy everywhere else is
 * untouched.
 */

import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';

// Compiled: dist/modules/openapi → ../../.. = backend root; tsx/jest:
// src/modules/openapi → same. The committed spec lives at the backend root.
const SPEC_FILE = path.resolve(__dirname, '..', '..', '..', 'openapi.json');

let cachedSpec: string | null | undefined; // undefined = not yet attempted

export const openApiJsonRouter = Router();

openApiJsonRouter.get('/openapi.json', (_req, res) => {
  if (cachedSpec === undefined) {
    try {
      cachedSpec = fs.readFileSync(SPEC_FILE, 'utf8');
    } catch {
      cachedSpec = null;
    }
  }
  if (cachedSpec === null) {
    res.status(404).json({
      error: 'openapi.json has not been generated yet — run `cd backend && npm run openapi:generate` and redeploy.',
    });
    return;
  }
  res.type('application/json').send(cachedSpec);
});

// Scoped CSP exception for the Swagger UI HTML (see header comment). helmet's
// defaults are kept; only script-src gains 'unsafe-inline' (style-src already
// allows it by default).
const apiDocsCsp = helmet({
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'script-src': ["'self'", "'unsafe-inline'"],
    },
  },
});

export const apiDocsRouter = Router();
apiDocsRouter.use(
  apiDocsCsp,
  swaggerUi.serve,
  swaggerUi.setup(undefined, { swaggerOptions: { url: '/api/openapi.json' } })
);
