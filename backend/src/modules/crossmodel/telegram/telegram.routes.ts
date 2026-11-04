/**
 * Telegram Bot Routes
 *
 * Mounted under /api/crossmodel/telegram by crossmodel.routes.ts, BEFORE the
 * global authenticate middleware: the webhook is public (called by Telegram with
 * no JWT — it is verified via the X-Telegram-Bot-Api-Secret-Token header).
 * The user-facing routes apply `authenticate` individually.
 */

import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import controller from './telegram.controller';

const router = Router();

// Public — called by Telegram. Secret-header verified inside the handler.
router.post('/webhook', (req, res) => controller.webhook(req, res));

// User-facing — require auth.
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));
router.post('/connect-link', authenticate, (req, res, next) => controller.getConnectLink(req, res, next));
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
