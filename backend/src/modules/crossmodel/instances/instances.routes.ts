/**
 * Digby Edge (Phase 3) — connected-instance routes (CLOUD side).
 *
 * Two routers, split by the app.ts ordering contract (see the mount-order
 * comment there):
 *
 *   instancesOpenRoutes — mounted BEFORE the single guard:
 *     POST /instances/pair/complete — the edge redeems a pairing code. OPEN
 *       (self-authenticating via the single-use code; uniform 401 on any bad
 *       code) and rate-limited per-IP in app.ts. Must NEVER take a JWT or end
 *       non-matching requests.
 *     DELETE /instances/self — the edge revokes its own pairing with its dgi_
 *       bearer token (best-effort half of the edge's unlink). Uniform 401.
 *
 *   default (authed) — mounted AFTER the guard (no internal authenticate;
 *     rejectChild stays), all ADMIN-gated in the controller:
 *     POST   /instances/pair/start  — mint a 10-min single-use code (shown once)
 *     POST   /instances/pair/redeem — device activation: enter the code shown on
 *                                     the edge; parks a Redis claim the relay
 *                                     consumes when the edge dials the tunnel
 *     GET    /instances             — owner-scoped list (online flag, never
 *                                     tokenHash; revoked rows excluded unless
 *                                     ?includeRevoked=1)
 *     DELETE /instances/:id         — revoke (owner-only; 404 hides other owners' rows)
 *
 * The relay-facing endpoints (WS tunnel + proxy) are NOT here — they live on
 * the separate relay process (backend/src/relay.ts) which shares DB/Redis.
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import controller from './instances.controller';
import { completePairingSchema, redeemPairingSchema } from './instances.validation';

export const instancesOpenRoutes = Router();
instancesOpenRoutes.post('/instances/pair/complete', validate(completePairingSchema), controller.completePair.bind(controller));
instancesOpenRoutes.delete('/instances/self', controller.selfRevoke.bind(controller));

const router = Router();
router.use(rejectChild);

router.post('/instances/pair/start', controller.startPair.bind(controller));
router.post('/instances/pair/redeem', validate(redeemPairingSchema), controller.redeemPair.bind(controller));
router.get('/instances', controller.list.bind(controller));
router.delete('/instances/:id', controller.revoke.bind(controller));

export default router;
