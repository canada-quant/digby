/**
 * Drive watch webhook receiver (2026-09-29, owner-confirmed cf_822011a4).
 *
 * Google's Drive push channel (changes.watch) POSTs here whenever the watched
 * folder changes. This endpoint is mounted on the OPEN router (see
 * crossmodel-open.routes.ts) — reachable WITHOUT a Bearer token because the
 * caller is Google, not a logged-in user.
 *
 * UNAUTHENTICATED-BUT-SAFE (same shape as webhook.controller.ts fireWebhook):
 * the request carries no user JWT, so the only thing that may fire a row is a
 * push whose channelId AND resourceId both match the stored DriveWatch row —
 * resourceId is a Google-minted opaque string delivered only in the
 * changes.watch response, never logged, never exposed by any API. All gate
 * logic lives in drive-watch.service.ts handleDrivePush; this file only
 * forwards headers + maps the outcome to a status code.
 *
 * Response contract (Google retries non-2xx aggressively):
 *   - always 200 on internal processing errors (catch + log, still 200)
 *   - 400 for a malformed push (missing X-Goog-* headers)
 *   - 404 for an unknown channel (stops Google's retries)
 *   - 403 for a channelId/resourceId mismatch (not our channel)
 *   - 200 for sync pings, not_exists pings, expired stragglers, dedupe-empty
 *     pulls, and successful fires
 *
 * Never log tokens or resourceIds.
 */
import { Router, type Request, type Response } from 'express';
import { handleDrivePush } from './drive-watch.service';
import logger from '../../../utils/logger';

const router = Router();

/**
 * POST /api/crossmodel/google/drive-watch/webhook
 *
 * Google Drive push notification receiver. Reads the X-Goog-* headers and
 * delegates the verify + pull + wake decision to the service. Responds 200
 * even on internal errors so Google does not retry a poisoned ping forever.
 */
router.post('/webhook', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status } = await handleDrivePush(req.headers);
    res.status(status).end();
  } catch (err: any) {
    // Google retries non-2xx aggressively — absorb the fault, log, still 200.
    // Never log the request headers (they carry the channel token / resourceId).
    logger.warn(`drive-watch webhook: internal error (responding 200): ${err?.message ?? err}`, {
      source: 'drive-watch',
    });
    res.status(200).end();
  }
});

export default router;
