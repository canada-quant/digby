/**
 * Plaid Routes
 *
 * Mounted under /api/crossmodel/plaid by crossmodel.routes.ts
 * All routes require authentication (no public callback — Plaid Link is client-side).
 */

import { Router } from 'express';
import { authenticate } from '../../../middleware/auth';
import controller from './plaid.controller';

const router = Router();

/**
 * POST /api/crossmodel/plaid/link-token
 * [authenticated] Create a Plaid Link token for the frontend widget.
 */
router.post('/link-token', authenticate, (req, res, next) => controller.createLinkToken(req, res, next));

/**
 * POST /api/crossmodel/plaid/exchange
 * [authenticated] Exchange public_token from Plaid Link for access_token.
 */
router.post('/exchange', authenticate, (req, res, next) => controller.exchangeToken(req, res, next));

/**
 * GET /api/crossmodel/plaid/status
 * [authenticated] Return Plaid connection status.
 */
router.get('/status', authenticate, (req, res, next) => controller.getStatus(req, res, next));

/**
 * DELETE /api/crossmodel/plaid/disconnect
 * [authenticated] Delete all Plaid tokens from DB.
 */
router.delete('/disconnect', authenticate, (req, res, next) => controller.disconnect(req, res, next));

export default router;
