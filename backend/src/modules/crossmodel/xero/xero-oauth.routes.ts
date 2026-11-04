/**
 * Xero OAuth Routes
 *
 * Mounted under /api/crossmodel/xero by crossmodel.routes.ts
 */

import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import controller from './xero-oauth.controller';

const router = Router();

/**
 * GET /api/crossmodel/xero/auth
 * [authenticated] Start Xero OAuth flow — redirects to Xero consent screen.
 * Uses optionalAuthenticate because the browser follows this as a redirect.
 */
router.get('/auth', optionalAuthenticate, (req, res, next) => controller.startAuth(req, res, next));

/**
 * GET /api/crossmodel/xero/callback
 * [public — called by Xero] Handle OAuth callback, exchange code for tokens.
 */
router.get('/callback', (req, res, next) => controller.handleCallback(req, res, next));

/**
 * GET /api/crossmodel/xero/status
 * [authenticated] Return Xero connection status.
 */
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));

/**
 * GET /api/crossmodel/xero/accounts
 * [authenticated] List ALL connected Xero accounts with labels (ticket 64a25e8d).
 */
router.get('/accounts', authenticate, (req, res, next) => controller.listAccounts(req, res, next));

/**
 * PATCH /api/crossmodel/xero/accounts/:id/label
 * [authenticated] Rename one account's label (400 invalid · 404 not yours · 409 taken).
 */
router.patch('/accounts/:id/label', authenticate, (req, res, next) => controller.updateAccountLabel(req, res, next));

/**
 * GET /api/crossmodel/xero/debug-config
 * [public] Show OAuth config for debugging (no secrets exposed).
 */
router.get('/debug-config', (req, res) => controller.debugConfig(req, res));

/**
 * DELETE /api/crossmodel/xero/disconnect
 * [authenticated] Delete Xero token from DB.
 */
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
