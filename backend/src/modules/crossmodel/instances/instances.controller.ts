/**
 * Digby Edge (Phase 3) — thin HTTP transport over instances.service.ts
 * (mirrors model-endpoints.controller.ts: try/catch → next(error), the ADMIN
 * gate 403s BEFORE touching the service). pair/complete is OPEN — it
 * self-authenticates via the single-use code and answers every bad code with
 * the same 401 (no user enumeration, no code-state oracle).
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth';
import * as service from './instances.service';

/** Same gate crossmodel.controller's admin handlers use. */
function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return false;
  }
  return true;
}

class InstancesController {
  /** POST /instances/pair/start (JWT + ADMIN) — mint a 10-min single-use code. */
  async startPair(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const { code, expiresAt } = await service.startPairing(req.user!.id);
      res.json({ success: true, data: { code, expiresAt } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /instances/pair/complete (OPEN, rate-limited in app.ts) — the edge
   * redeems a code for its `dgi_` tunnel token. Uniform 401 for ANY bad code.
   * Body (validated): { code, instanceName, protocolVersion? }
   */
  async completePair(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { code, instanceName, protocolVersion } = req.body || {};
      const result = await service.completePairing(code, instanceName, protocolVersion);
      if (!result) {
        return res.status(401).json({ success: false, error: 'Invalid or expired pairing code' });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /instances/self (OPEN) — an edge revokes its own pairing with its
   * `dgi_` bearer token (the edge's unlink tells the cloud best-effort).
   * Uniform 401 for any bad token — same posture as pair/complete.
   */
  async selfRevoke(req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const authz = req.headers.authorization || '';
      const token = authz.startsWith('Bearer ') ? authz.slice(7) : '';
      const revoked = token ? await service.revokeByToken(token) : false;
      if (!revoked) return res.status(401).json({ success: false, error: 'Invalid instance token' });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }

  /** GET /instances (JWT + ADMIN, owner-scoped) — sanitized list + online flag.
   *  Revoked rows are excluded unless ?includeRevoked=1. */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const includeRevoked = req.query.includeRevoked === '1' || req.query.includeRevoked === 'true';
      res.json({ success: true, data: { instances: await service.listInstances(req.user!.id, { includeRevoked }) } });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /instances/pair/redeem (JWT + ADMIN, rate-limited in app.ts) —
   * device-activation pairing: the admin enters the code shown on the EDGE.
   * Parks a 10-min claim in Redis; the instance row materializes when the
   * edge's pending-pair dial hits the relay. 400 on a malformed code.
   */
  async redeemPair(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const result = await service.redeemPairingCode(req.body?.code, req.user!.id);
      if (!result) {
        return res.status(400).json({ success: false, error: 'Invalid pairing code format — expected XXXX-XXXX' });
      }
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /** DELETE /instances/:id (JWT + ADMIN + ownership) — revoke the pairing. */
  async revoke(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const revoked = await service.revokeInstance(req.params.id, req.user!.id);
      if (!revoked) return res.status(404).json({ error: 'Instance not found' });
      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  }
}

export default new InstancesController();
