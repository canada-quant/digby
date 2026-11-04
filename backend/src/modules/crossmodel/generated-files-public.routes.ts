/**
 * Generated Files — query-token download route, isolated in a router with NO
 * request-ending middleware, mounted BEFORE the app-level authenticate guard.
 *
 * Why separate: chat markdown download links are plain browser <a> navigations
 * — they can't send an Authorization header, so this route authenticates via
 * the cm_access cookie or ?token= (optionalAuthenticate) and the handler
 * self-checks req.user + file ownership. Precedent: coding-public.routes.ts
 * (the coding SSE/preview routes use the identical pattern for EventSource).
 * Non-matching paths fall through cleanly to the guard.
 */

import { Router } from 'express';
import { optionalAuthenticate, rejectChild } from '../../middleware/auth';
import controller from './generated-files.controller';

const router = Router();

// Per-route rejectChild (NOT router.use — open-router contract) mirrors the
// Bearer twin (generated-files.routes.ts): Digby Kids is an adult-workspace
// gate, and this query-token twin must not be a child-account bypass. It reads
// the req.user optionalAuthenticate sets; anonymous requests pass through to
// the handler's own 401.
router.get('/generated-files/:id/download', optionalAuthenticate, rejectChild, controller.downloadGeneratedFile);

// Inline IMAGE twin (generate_image, 2026-09-24): a transcript <img src> and
// the Files thumbnails are plain browser fetches on the cm_access cookie —
// same posture as the download twin (optionalAuthenticate + per-route
// rejectChild; the handler self-checks req.user and ownership, image/* only).
router.get('/generated-files/:id/inline', optionalAuthenticate, rejectChild, controller.inlineGeneratedFile);

export default router;
