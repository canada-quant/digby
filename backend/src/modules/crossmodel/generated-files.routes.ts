import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import controller from './generated-files.controller';

const router = Router();

// Authenticated by the app-level guard (app.ts) — no router.use(authenticate).
router.use(rejectChild); // Digby Kids: adult workspace — child tokens are rejected

// List the caller's generated files (metadata only)
router.get('/generated-files', controller.listGeneratedFiles);

// Download (Bearer-authed variant; the query-token variant lives on the
// pre-guard router — see generated-files-public.routes.ts)
router.get('/generated-files/:id/download', controller.downloadGeneratedFile);

// Inline IMAGE bytes (generate_image transcript parts / Files thumbnails,
// 2026-09-24) — image/* only, 415 otherwise. Bearer-authed variant; the
// cookie/query-token twin (what a plain <img src> uses) lives on the pre-guard
// router — see generated-files-public.routes.ts.
router.get('/generated-files/:id/inline', controller.inlineGeneratedFile);

// Delete a generated file
router.delete('/generated-files/:id', controller.deleteGeneratedFile);

export default router;
