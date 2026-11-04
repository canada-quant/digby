import { Router } from 'express';
import { rejectChild } from '../../middleware/auth';
import canvasController from './canvas.controller';

const router = Router();

// Authenticated by the app-level guard (app.ts) — no router.use(authenticate).
router.use(rejectChild); // Digby Kids: adult workspace — child tokens are rejected

// List ALL canvases for the user (for Files section)
router.get('/canvases', canvasController.listAll.bind(canvasController));

// Chat-scoped canvas routes
router.get('/chats/:id/canvases', canvasController.listCanvases.bind(canvasController));
router.post('/chats/:id/canvases', canvasController.createCanvas.bind(canvasController));

// Individual canvas routes
router.get('/canvases/:id', canvasController.getCanvas.bind(canvasController));
router.put('/canvases/:id', canvasController.updateCanvas.bind(canvasController));
router.delete('/canvases/:id', canvasController.deleteCanvas.bind(canvasController));

// Public sharing (the public GET lives in public-share.routes.ts — no auth)
router.get('/canvases/:id/share', canvasController.getCanvasShareStatus.bind(canvasController));
router.post('/canvases/:id/share', canvasController.shareCanvas.bind(canvasController));
router.delete('/canvases/:id/share', canvasController.revokeCanvasShare.bind(canvasController));

export default router;
