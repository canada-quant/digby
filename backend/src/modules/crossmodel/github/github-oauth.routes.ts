/**
 * GitHub OAuth Routes
 *
 * Mounted under /api/crossmodel/github by crossmodel.routes.ts
 */

import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import controller from './github-oauth.controller';

const router = Router();

router.get('/auth', optionalAuthenticate, (req, res, next) => controller.startAuth(req, res, next));
router.get('/callback', (req, res, next) => controller.handleCallback(req, res, next));
router.post('/pat', authenticate, (req, res, next) => controller.connectPat(req, res, next));
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));
router.get('/accounts', authenticate, (req, res, next) => controller.listAccounts(req, res, next));
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
