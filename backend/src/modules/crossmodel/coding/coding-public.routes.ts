/**
 * Digby Code — query-token routes, isolated in a router with NO request-ending
 * middleware, mounted BEFORE the app-level authenticate guard.
 *
 * Why separate: EventSource can't send an Authorization header, so these routes
 * authenticate from ?token= via optionalAuthenticate. If they lived behind the
 * guard (like the main coding router's header-auth routes), the documented
 * Express gotcha applies — the request would hit the guard and 401 ("No token
 * provided") before reaching this handler. Keeping them here (like
 * public-share.routes) lets non-matching paths fall through cleanly.
 *
 * P4: the coding SSE run endpoint itself MOVED to the unified
 * GET /api/crossmodel/chats/:id/stream (crossmodel.routes.ts) — the route here
 * is only a 308 redirect that preserves the query string (token / message).
 */

import { Router, type Request, type Response } from 'express';
import { optionalAuthenticate } from '../../../middleware/auth';
import previewController from './coding-preview.controller';
import { handleCredentialProxy, credentialProxyHealth } from './credential-proxy';

const router = Router();

// P4: RETIRED in favor of the ONE chat run stream, GET /api/crossmodel/chats/:id/stream
// (crossmodel.routes.ts — it resolves both live-run key forms, so a coding run
// attaches exactly as before). 308 preserves the method AND we preserve the
// full query string verbatim: `?token=` (EventSource auth) and the back-compat
// `?message=` run-start both keep working through the new endpoint.
router.get('/coding/sessions/:id/stream', (req, res) => {
  const qs = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
  res.redirect(308, `/api/crossmodel/chats/${encodeURIComponent(req.params.id)}/stream${qs}`);
});

// Live app preview — an iframe (no headers) hits this with ?token=, then a
// path-scoped cookie authenticates sub-resources. Query-token/cookie, so it lives
// here (before the app-level guard), like the stream.
const previewChain = [
  previewController.cookieToQuery.bind(previewController),
  optionalAuthenticate,
  previewController.preview.bind(previewController),
];
router.get('/coding/sessions/:id/preview/:port', ...previewChain);
// Express 5 / path-to-regexp v8: a bare '*' wildcard is rejected — it must be
// named (/*splat). The tail then arrives as string[] in req.params.splat.
router.get('/coding/sessions/:id/preview/:port/*splat', ...previewChain);

// build 2026-10-08 ISO — the credential proxy (coding/credential-proxy.ts).
// Sandboxes call it with a session-bound capability (X-Digby-Cap), never a
// user JWT, so it lives here (before the app-level guard) and authenticates
// per request. A request without a valid capability is a uniform 401; the
// upstream allowlist is fixed (git smart-HTTP to github.com; the GitHub /
// Google / Slack / Asana API hosts). Inert until CODING_CREDENTIAL_PROXY
// mints a capability for some run.
// Literal paths (the openapi scanner reads string literals) = PROXY_ROUTE_PREFIX + …
router.get('/coding/cred-proxy/health', credentialProxyHealth);
const gitProxy = (req: Request, res: Response) => { void handleCredentialProxy('git', req, res); };
const apiProxy = (req: Request, res: Response) => { void handleCredentialProxy('api', req, res); };
router.get('/coding/cred-proxy/git/*splat', gitProxy);
router.post('/coding/cred-proxy/git/*splat', gitProxy);
router.get('/coding/cred-proxy/api/:provider/*splat', apiProxy);
// build 2026-10-11 ISO-GH: the API ROOT (GET https://api.github.com/) — `gh auth status` reads the
// token's scopes from it (X-OAuth-Scopes); `*splat` needs at least one segment.
router.get('/coding/cred-proxy/api/:provider', apiProxy);
router.post('/coding/cred-proxy/api/:provider/*splat', apiProxy);
router.put('/coding/cred-proxy/api/:provider/*splat', apiProxy);
router.patch('/coding/cred-proxy/api/:provider/*splat', apiProxy);
router.delete('/coding/cred-proxy/api/:provider/*splat', apiProxy);

export default router;
