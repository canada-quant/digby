/**
 * Digby Edge (Phase 3) — thin HTTP transport over cloud-link.service.ts
 * (mirrors model-endpoints.controller.ts: try/catch → next(error), the ADMIN
 * gate 403s BEFORE touching the service).
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth';
import * as service from './cloud-link.service';

/** Same gate crossmodel.controller's admin handlers use. */
function requireAdmin(req: AuthRequest, res: Response): boolean {
  if (req.user?.role !== 'ADMIN') {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return false;
  }
  return true;
}

class CloudLinkController {
  /** GET /cloud-link — sanitized link status (never tokenEnc). */
  async status(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.getCloudLinkStatus() });
    } catch (error) {
      next(error);
    }
  }

  /** POST /cloud-link/pair — redeem a cloud pairing code + start the tunnel. */
  async pair(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const { cloudUrl, pairingCode, instanceName } = req.body;
      const status = await service.pairToCloud(req.user!.id, cloudUrl, pairingCode, instanceName);
      res.json({ success: true, data: status });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /cloud-link/code/start — device-activation pairing: mint a one-time
   * code HERE (the cloud admin redeems it under Connected instances → Add by
   * code) and start the tunnel client's pending-pair dial.
   */
  async startCode(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      const { cloudUrl, instanceName } = req.body;
      const result = await service.startEdgePairingCode(req.user!.id, cloudUrl, instanceName);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }

  /** POST /cloud-link/unlink — stop the tunnel + delete the row. */
  async unlink(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    try {
      res.json({ success: true, data: await service.unlinkFromCloud() });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /cloud-link/receive (Phase 5) — the paired CLOUD pushes a message
   * into one of this instance's chats. Tunnel-only: beyond the ADMIN gate the
   * request must carry the `x-cloud-relay: 1` header the tunnel client
   * injects on every tunneled call — a directly-hit API request (even with a
   * valid admin JWT) gets the SAME uniform 403, so the only path in is the
   * authenticated cloud tunnel. The body is zod-validated at the route.
   */
  async receive(req: AuthRequest, res: Response, next: NextFunction) {
    if (!requireAdmin(req, res)) return;
    if (req.headers?.['x-cloud-relay'] !== '1') {
      res.status(403).json({ error: 'Forbidden: cloud-relay tunnel only' });
      return;
    }
    try {
      const { chatId, message, sourceLabel, depth } = req.body;
      const result = await service.receiveCloudMessage({ chatId, message, sourceLabel, depth });
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  }
}

export default new CloudLinkController();
