/**
 * Plaid Controller
 *
 * Handles Plaid Link integration — no OAuth redirect needed.
 * Plaid uses a client-side widget (Plaid Link) that returns a public_token,
 * which the backend exchanges for a permanent access_token.
 *
 * Endpoints:
 *   POST   /api/crossmodel/plaid/link-token    — Create a Link token
 *   POST   /api/crossmodel/plaid/exchange       — Exchange public_token
 *   GET    /api/crossmodel/plaid/status         — Check connection status
 *   DELETE /api/crossmodel/plaid/disconnect     — Delete all Plaid tokens
 */

import { Request, Response, NextFunction } from 'express';
import axios from 'axios';
import prisma from '../../../config/database';
import { storePlaidToken, deletePlaidTokens } from './token-manager';
import { invalidateIntegrationStatusCache } from '../langgraph/integration-status-cache';
import logger from '../../../utils/logger';

const PLAID_ENV = process.env.PLAID_ENV || 'production';
const PLAID_BASE_URL = PLAID_ENV === 'sandbox'
  ? 'https://sandbox.plaid.com'
  : PLAID_ENV === 'development'
    ? 'https://development.plaid.com'
    : 'https://production.plaid.com';

// Country codes — default to US only. Production Plaid accounts must explicitly
// request access to additional countries via the Plaid Dashboard.
// Override with PLAID_COUNTRY_CODES env var (comma-separated, e.g. "US,CA,GB").
const PLAID_COUNTRY_CODES = (process.env.PLAID_COUNTRY_CODES || 'US')
  .split(',')
  .map(c => c.trim().toUpperCase())
  .filter(Boolean);

/** Shown to the user when Plaid credentials are set but the token key is not. */
export const PLAID_KEY_MISSING_MSG = 'Plaid is set up, but this instance cannot store a bank token: GOOGLE_TOKEN_ENCRYPTION_KEY is not set. An administrator fixes that under Account → Admin → Setup.';

export class PlaidController {

  /** POST /api/crossmodel/plaid/link-token */
  async createLinkToken(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) { res.status(401).json({ error: 'Authentication required.' }); return; }
      const clientId = process.env.PLAID_CLIENT_ID;
      const secret   = process.env.PLAID_SECRET;
      if (!clientId || !secret) {
        logger.warn('Plaid: credentials not configured');
        res.status(503).json({ error: 'Plaid integration not configured.' }); return;
      }
      // The access token is stored encrypted with GOOGLE_TOKEN_ENCRYPTION_KEY
      // (plaid/token-manager.ts) — refuse BEFORE Plaid Link opens instead of
      // failing the exchange after the user picked a bank (2026-10-20 self-host
      // hardening; production sets the key).
      if (!process.env.GOOGLE_TOKEN_ENCRYPTION_KEY) {
        logger.warn('Plaid: GOOGLE_TOKEN_ENCRYPTION_KEY is not set — cannot store a bank token');
        res.status(503).json({ error: PLAID_KEY_MISSING_MSG }); return;
      }
      const userId = req.user.id;
      const response = await axios.post(`${PLAID_BASE_URL}/link/token/create`, {
        client_id: clientId, secret,
        user: { client_user_id: userId },
        client_name: 'Digby AI',
        products: ['transactions'],
        country_codes: PLAID_COUNTRY_CODES,
        language: 'en',
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      const linkToken = response.data?.link_token;
      if (!linkToken) { res.status(500).json({ error: 'Failed to create link token.' }); return; }
      logger.info(`Plaid: link token created for userId=${userId}`);
      res.json({ success: true, data: { linkToken } });
    } catch (error: any) {
      const plaidMsg = error.response?.data?.error_message || error.message;
      logger.error(`Plaid createLinkToken: ${plaidMsg}`);
      // Return a user-friendly error instead of propagating the raw Plaid error
      res.status(error.response?.status || 500).json({
        error: 'Failed to initialize Plaid Link. Please try again later.',
        detail: plaidMsg,
      });
    }
  }

  /** POST /api/crossmodel/plaid/exchange */
  async exchangeToken(req: Request, res: Response, next: NextFunction) {
    try {
      if (!req.user) { res.status(401).json({ error: 'Authentication required.' }); return; }
      const clientId = process.env.PLAID_CLIENT_ID;
      const secret   = process.env.PLAID_SECRET;
      if (!clientId || !secret) { res.status(503).json({ error: 'Plaid not configured.' }); return; }
      const { publicToken, institutionId, institutionName } = req.body;
      if (!publicToken) { res.status(400).json({ error: 'publicToken is required.' }); return; }
      const userId = req.user.id;
      const response = await axios.post(`${PLAID_BASE_URL}/item/public_token/exchange`, {
        client_id: clientId, secret, public_token: publicToken,
      }, { headers: { 'Content-Type': 'application/json' }, timeout: 15000 });
      const { access_token, item_id } = response.data;
      if (!access_token || !item_id) { res.status(500).json({ error: 'Token exchange failed.' }); return; }
      await storePlaidToken(userId, access_token, item_id, institutionId, institutionName);
      await invalidateIntegrationStatusCache(userId); // surface the new connection immediately (don't wait for TTL)
      logger.info(`Plaid: connected userId=${userId}, institution=${institutionName || 'unknown'}`);
      res.json({ success: true, message: 'Bank account connected successfully.' });
    } catch (error: any) {
      logger.error(`Plaid exchangeToken: ${error.response?.data?.error_message || error.message}`);
      next(error);
    }
  }

  /** GET /api/crossmodel/plaid/status */
  async getStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const configured = !!(process.env.PLAID_CLIENT_ID && process.env.PLAID_SECRET && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
      const rows = await (prisma as any).plaidAccessToken.findMany({
        where: { userId },
        select: { institutionName: true, institutionId: true, createdAt: true, label: true },
      });
      if (rows.length === 0) {
        return res.json({ success: true, data: { connected: false, configured, institutions: [] } });
      }
      const institutions = rows.map((r: any) => ({
        name: r.institutionName || r.label || 'Unknown',
        id: r.institutionId, connectedAt: r.createdAt,
      }));
      res.json({ success: true, data: { connected: true, configured, institutions } });
    } catch (error) { next(error); }
  }

  /** DELETE /api/crossmodel/plaid/disconnect */
  async disconnect(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const count = await deletePlaidTokens(userId);
      if (count === 0) { return res.json({ success: true, message: 'Not connected to Plaid' }); }
      await invalidateIntegrationStatusCache(userId);
      logger.info(`Plaid: disconnected userId=${userId} (${count} items)`);
      res.json({ success: true, message: 'Plaid disconnected' });
    } catch (error) { next(error); }
  }
}

export default new PlaidController();
