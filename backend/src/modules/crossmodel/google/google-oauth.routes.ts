/**
 * Google OAuth Routes
 *
 * Mounted under /api/crossmodel/google by crossmodel.routes.ts
 */

import { Router } from 'express';
import { authenticate, optionalAuthenticate } from '../../../middleware/auth';
import controller from './google-oauth.controller';

const router = Router();

/**
 * GET /api/crossmodel/google/auth
 * [authenticated] Start Google OAuth flow — redirects to Google consent screen.
 *
 * Uses optionalAuthenticate (not authenticate) because the browser follows this as a
 * redirect — it cannot set Authorization headers. The token is passed as ?token=<jwt>
 * query param instead (same pattern as the SSE stream endpoint).
 * The controller verifies req.user is set before proceeding.
 */
router.get('/auth', optionalAuthenticate, (req, res, next) => controller.startAuth(req, res, next));

/**
 * GET /api/crossmodel/google/callback
 * [public — called by Google] Handle OAuth callback, exchange code for tokens.
 * Redirects to frontend after storing tokens.
 */
router.get('/callback', (req, res, next) => controller.handleCallback(req, res, next));

/**
 * GET /api/crossmodel/google/status
 * [authenticated] Return first connected account status (backward compat).
 */
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));

/**
 * GET /api/crossmodel/google/accounts
 * [authenticated] Return all connected Google accounts for the user.
 */
router.get('/accounts', authenticate, (req, res, next) => controller.listAccounts(req, res, next));

/**
 * PATCH /api/crossmodel/google/accounts/:id/label
 * [authenticated] Rename one of the user's connected Google accounts.
 * Body: { label } — 400 invalid · 404 not the user's account · 409 label taken.
 */
router.patch('/accounts/:id/label', authenticate, (req, res, next) => controller.updateAccountLabel(req, res, next));

/**
 * DELETE /api/crossmodel/google/disconnect
 * [authenticated] Revoke Google access token and delete from DB.
 * If ?label=<label> is provided, disconnects only that account.
 * Otherwise disconnects all accounts (backward compat).
 */
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

/**
 * POST /api/crossmodel/google/send-email
 * [authenticated] Send email on behalf of user (called after UI confirmation).
 * Body: { to, subject, body, cc?, bcc? }
 */
router.post('/send-email', authenticate, (req, res, next) => controller.sendEmail(req, res, next));

export default router;
