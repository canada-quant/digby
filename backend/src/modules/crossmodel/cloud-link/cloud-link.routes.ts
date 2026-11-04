/**
 * Digby Edge (Phase 3) — cloud-link routes (EDGE side). All ADMIN-only,
 * authenticated by the app-level /api/crossmodel guard in app.ts — no
 * router.use(authenticate) here (see the ordering contract in app.ts;
 * model-endpoints.routes.ts is the template).
 *
 *   GET  /cloud-link        — sanitized status (never tokenEnc)
 *   POST /cloud-link/pair   — redeem a cloud pairing code, store the link,
 *                             start the tunnel client
 *   POST /cloud-link/code/start — device activation: mint the code HERE (the
 *                             cloud admin redeems it), start the tunnel
 *                             client's pending-pair dial
 *   POST /cloud-link/unlink — stop the client, delete the row (best-effort
 *                             cloud-side self-revoke first)
 *   POST /cloud-link/receive — Phase 5: the paired cloud pushes a message into
 *                             one of this instance's chats (tunnel-only —
 *                             requires the x-cloud-relay: 1 header the tunnel
 *                             client injects; per-chat rate-limited in app.ts)
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import controller from './cloud-link.controller';
import { pairCloudLinkSchema, receiveCloudMessageSchema, startEdgePairingCodeSchema } from './cloud-link.validation';

const router = Router();

router.use(rejectChild);

router.get('/cloud-link', controller.status.bind(controller));
router.post('/cloud-link/pair', validate(pairCloudLinkSchema), controller.pair.bind(controller));
router.post('/cloud-link/code/start', validate(startEdgePairingCodeSchema), controller.startCode.bind(controller));
router.post('/cloud-link/unlink', controller.unlink.bind(controller));
router.post('/cloud-link/receive', validate(receiveCloudMessageSchema), controller.receive.bind(controller));

export default router;
