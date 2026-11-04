/**
 * Mobile push-token registration (M1 — roadmap §3.2 item 2).
 *
 * Mounted in app.ts BEHIND the single app-level `authenticate` guard (an
 * authed surface — a device token is per-user). rejectChild: Digby Kids
 * never receives push (child accounts are confined to the kid pipeline).
 */

import { Router } from 'express';
import { rejectChild } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import { z } from 'zod';
import { registerPushToken, unregisterPushToken, pushTransportsConfigured } from './push.service';

export const pushRoutes = Router();
pushRoutes.use(rejectChild);

const registerPushSchema = z.object({
  body: z.object({
    token: z.string().min(16, 'Device token is required').max(512),
    provider: z.enum(['expo', 'apns', 'fcm']).optional(),
    platform: z.enum(['ios', 'android']).optional(),
    deviceId: z.string().max(128).optional(),
    appVersion: z.string().max(32).optional(),
  }),
});

pushRoutes.post('/register', validate(registerPushSchema), async (req, res, next) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    const { token, provider, platform, deviceId, appVersion } = req.body;
    await registerPushToken({ userId: user.id, token, provider, platform, deviceId, appVersion });
    return res.json({ success: true, data: { registered: true, transports: pushTransportsConfigured() } });
  } catch (error) {
    return next(error);
  }
});

pushRoutes.delete('/:token', async (req, res, next) => {
  try {
    const user = (req as any).user;
    if (!user?.id) return res.status(401).json({ error: 'Authentication required' });
    await unregisterPushToken(user.id, String(req.params.token || ''));
    return res.json({ success: true, data: { unregistered: true } });
  } catch (error) {
    return next(error);
  }
});

/** Transport availability (client diagnostics: is push configured server-side?). */
pushRoutes.get('/status', (_req, res) => {
  return res.json({ success: true, data: pushTransportsConfigured() });
});
