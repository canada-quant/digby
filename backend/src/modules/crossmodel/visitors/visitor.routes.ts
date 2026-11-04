/**
 * First-party visitor analytics routes (owner 2026-10-07).
 *
 *  - visitEventsBodyParser: the open POST /visit-events accepts a sendBeacon text/plain body (≤ 64 KB) besides the
 *    global JSON parser; the route itself lives in crossmodel-open.routes.ts (BEFORE the single auth guard).
 *  - visitorAdminRoutes: the admin reads — mounted in app.ts AFTER the single guard (no internal authenticate —
 *    the ordering contract); each handler applies the admin gate.
 */
import express, { Router } from 'express';
import { getTrafficFlow, getTrafficSources, getTrafficUsers } from './visitor.controller';

export const visitEventsBodyParser = express.text({ type: 'text/plain', limit: '64kb' });

const router = Router();

/** GET /api/crossmodel/admin/traffic/sources?from=YYYY-MM-DD&to=YYYY-MM-DD — channels, campaigns, funnel, paths (admin). */
router.get('/admin/traffic/sources', getTrafficSources);
/** GET /api/crossmodel/admin/traffic/users?q&sort&dir&page&pageSize&kind=all|users|visitors&channel — the users table (admin). */
router.get('/admin/traffic/users', getTrafficUsers);
/** GET /api/crossmodel/admin/traffic/flow?userId= | ?visitorId= — one subject's timeline (admin). */
router.get('/admin/traffic/flow', getTrafficFlow);

export const visitorAdminRoutes = router;
export default router;
