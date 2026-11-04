import { Router } from 'express';
import sharingController from './sharing.controller';
import projectsController from './projects.controller';
import canvasController from './canvas.controller';

/**
 * Public read-only share routes — no auth.
 *
 * MUST be mounted before the single app-level authenticate guard (see the
 * ordering contract in app.ts). Express walks routers in registration order;
 * an unmatched URL that reached the guard would 401 before falling through
 * to the unauthenticated handler.
 */
const router = Router();

router.get('/shared/chat/:token', sharingController.getSharedChat);
// GET /shared/chat/:token/image/:fileId — Generated-image bytes of a shared chat (token-scoped; image/* only, 404 otherwise).
// The public page's figures load from here (generate_image tranche B, 2026-09-24):
// the handler re-applies getSharedChat's link checks (exists + active + unexpired,
// never a coding chat) and binds the GeneratedFile to the chat (owner AND chatId)
// before serving inline with nosniff + public caching. Anything else is a 404 —
// never a 415/410 that would confirm a file or link exists.
router.get('/shared/chat/:token/image/:fileId', sharingController.getSharedChatImage);
router.get('/shared/project/:token', projectsController.getPublicProject);
// Shared canvas ARTIFACT — served as a real web page (HTML runs sandboxed).
// One backend route serves every chat's artifacts straight from the DB row —
// deliberately NOT per-project containers (service-sprawl future-proofing).
router.get('/shared/canvas/:token', canvasController.getSharedCanvas.bind(canvasController));

export default router;
