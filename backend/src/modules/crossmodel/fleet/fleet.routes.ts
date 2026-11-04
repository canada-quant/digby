/**
 * Fleet Management routes — the Management UI backend. All auth-required,
 * adult-only. Authenticated by the app-level /api/crossmodel guard in app.ts —
 * deliberately NO router.use(authenticate) here (see the ordering contract in
 * app.ts; coding.routes.ts is the precedent for bare rejectChild).
 *
 *   GET  /fleet/supervisor          — the caller's supervisor chat + live view
 *   GET  /fleet/overview            — fleet-wide counts + summary rows
 *   GET  /fleet/supervisor/thread   — interactive (noise-filtered) transcript
 *   POST /fleet/supervisor/messages — send now, or queue FIFO when busy
 *   GET  /fleet/log                 — merged raw log (transcript + agent audits)
 *   GET  /fleet/digests             — stored hourly per-project digests (read-only)
 *   POST /fleet/digests/ack         — silence one digest attention item
 *   DELETE /fleet/digests/ack/:key  — lift a digest-item silence
 *   GET  /fleet/schedules           — every schedule the caller owns (Schedules tab)
 *   POST /fleet/schedules/:id/cancel — disable one schedule (audited)
 *
 * There is NO settings/designation endpoint: the supervisor is the owner's ONE
 * auto-provisioned isSupervisor chat (platform/supervisor.service.ts owns its
 * lifecycle; POST /supervisor/ensure on the platform router provisions it).
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import controller from './fleet.controller';
import {
  fleetSendMessageSchema,
  fleetThreadQuerySchema,
  fleetLogQuerySchema,
} from './fleet.validation';

const router = Router();

router.use(rejectChild);

router.get('/fleet/supervisor', controller.getSupervisor.bind(controller));
router.get('/fleet/overview', controller.getOverview.bind(controller));
router.get('/fleet/pulse', controller.getPulse.bind(controller));
router.get('/fleet/usage', controller.getUsage.bind(controller));
router.get('/fleet/supervisor/thread', validate(fleetThreadQuerySchema), controller.getThread.bind(controller));
// GET /fleet/supervisor/latest-summary — latest machine wake note (dashboard Fleet-summary card)
router.get('/fleet/supervisor/latest-summary', controller.getLatestSummary.bind(controller));
router.post('/fleet/supervisor/messages', validate(fleetSendMessageSchema), controller.postMessage.bind(controller));
router.get('/fleet/log', validate(fleetLogQuerySchema), controller.getLog.bind(controller));
router.get('/fleet/digests', controller.getDigests.bind(controller));
router.get('/fleet/schedules', controller.getSchedules.bind(controller));
router.post('/fleet/digests/ack', controller.ackDigestItem.bind(controller));
router.delete('/fleet/digests/ack/:key', controller.unackDigestItem.bind(controller));
router.post('/fleet/schedules/:id/cancel', controller.cancelSchedule.bind(controller));

export default router;
