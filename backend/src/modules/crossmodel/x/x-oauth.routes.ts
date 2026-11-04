import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import controller from './x-oauth.controller';

const router = Router();

// Start the OAuth flow — uses optionalAuthenticate so the JWT can ride in
// either the Authorization header or ?token=<jwt> query string (the browser
// follows a full-page redirect and can't send custom headers).
router.get('/auth', optionalAuthenticate, (req, res, next) => controller.startAuth(req, res, next));

// Callback is invoked by X — fully public.
router.get('/callback', (req, res, next) => controller.handleCallback(req, res, next));

// Authenticated endpoints
router.get('/status',         authenticate, (req, res, next) => controller.getStatus(req, res, next));
router.get('/accounts',       authenticate, (req, res, next) => controller.listAccounts(req, res, next));
router.delete('/disconnect',  authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
