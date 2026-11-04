/**
 * Digby Kids — child sub-account management routes.
 * AUTH IS APP-LEVEL: no router.use(authenticate) here — app.ts mounts the
 * single /api/crossmodel guard before this router (see the ordering contract
 * in app.ts). Per-route rejectChild below reads the req.user the guard sets.
 */
import { Router, Response, RequestHandler } from 'express';
import controller from './children.controller';
import { rejectChild, AuthRequest } from '../../middleware/auth';
import logger from '../../utils/logger';

const router = Router();

// Catch async errors so a thrown promise never hangs the request (Express 4).
// Returns a plain RequestHandler (casting req → AuthRequest internally) to avoid
// any handler-parameter variance issues at registration.
const h = (fn: (req: AuthRequest, res: Response) => Promise<any>): RequestHandler =>
  (req, res) => {
    fn(req as AuthRequest, res).catch((err: any) => {
      logger.error('children route error:', err?.message || err);
      if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
    });
  };

// All routes in this router are authenticated by the app-level guard (mounted
// in app.ts before this router) — no router.use(authenticate) here.

// Works for a child OR parent token — lets the kid UI gate "leave kid mode".
router.post('/children/verify-parent-pin', h((req, res) => controller.verifyParentPin(req, res)));

// Management — parents only (a child token is rejected).
router.get('/children', rejectChild, h((req, res) => controller.list(req, res)));
router.post('/children', rejectChild, h((req, res) => controller.create(req, res)));
router.patch('/children/:id', rejectChild, h((req, res) => controller.update(req, res)));
router.delete('/children/:id', rejectChild, h((req, res) => controller.remove(req, res)));

export default router;
