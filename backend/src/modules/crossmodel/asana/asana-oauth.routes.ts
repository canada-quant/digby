/**
 * Asana OAuth Routes
 *
 * Mounted under /api/crossmodel/asana by crossmodel.routes.ts.
 * The callback is public (called by Asana); the rest require authentication.
 */

import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import controller from './asana-oauth.controller';

const router = Router();

router.get('/auth', optionalAuthenticate, (req, res, next) => controller.startAuth(req, res, next));
router.get('/callback', (req, res, next) => controller.handleCallback(req, res, next));
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
