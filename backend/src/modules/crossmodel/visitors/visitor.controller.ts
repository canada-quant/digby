/**
 * First-party visitor analytics — HTTP handlers (owner 2026-10-07).
 *
 *  POST /api/crossmodel/visit-events   OPEN (crossmodel-open.routes.ts, optionalAuthenticate, rate-limited in app.ts):
 *    the web capture's batch — JSON or a sendBeacon text/plain body. Always 204 on success / skip (kill switch, bot,
 *    Digby Kids) so a beacon never retries; 400 only for a malformed body.
 *  GET /api/crossmodel/admin/traffic/sources?from=YYYY-MM-DD&to=YYYY-MM-DD   ADMIN
 *  GET /api/crossmodel/admin/traffic/users?q&sort&dir&page&pageSize&kind&channel   ADMIN (server-side paginated)
 *  GET /api/crossmodel/admin/traffic/flow?userId=… | ?visitorId=…   ADMIN (404 for a Digby Kids account)
 *
 * Admin = the same gate as every Account → Admin handler (role ADMIN or the owner account).
 */
import { Request, Response } from 'express';
import logger from '../../../utils/logger';
import { ingestVisitBatch, visitorAnalyticsDisabled, UUID_RE } from './visitor.service';
import { resolveRange, trafficFlow, trafficSources, trafficUsers } from './visitor-analytics.service';
import { isAdminViewer } from '../view/view-mode';

type ReqUser = { id?: string; userId?: string; email?: string; role?: string; isChild?: boolean };

/** Same gate crossmodel.controller's admin handlers use (isAdminViewer: the owner-email fallback is production-only). */
export function isTrafficAdmin(user: ReqUser | undefined | null): boolean {
  if (!user || user.isChild === true) return false;
  return isAdminViewer(user);
}

function forbid(res: Response): void {
  res.status(403).json({ error: 'Forbidden: admin access required' });
}

export async function postVisitEvents(req: Request, res: Response): Promise<void> {
  if (visitorAnalyticsDisabled()) { res.status(204).end(); return; }
  try {
    const r = await ingestVisitBatch({ body: req.body, user: (req as any).user as ReqUser | undefined, req: req as any });
    if (r.status === 'invalid') { res.status(400).json({ error: r.error }); return; }
    res.status(204).end();
  } catch (err: any) {
    logger.warn(`visit-events: unexpected failure (non-fatal): ${err?.message ?? err}`);
    res.status(204).end();
  }
}

export async function getTrafficSources(req: Request, res: Response): Promise<void> {
  if (!isTrafficAdmin((req as any).user)) { forbid(res); return; }
  try {
    const now = new Date();
    const { from, to } = resolveRange(req.query.from, req.query.to, now);
    res.json({ success: true, data: await trafficSources({ from, to, now }) });
  } catch (err: any) {
    logger.error(`getTrafficSources error: ${err?.message ?? err}`);
    res.status(500).json({ error: 'Failed to load traffic sources' });
  }
}

export async function getTrafficUsers(req: Request, res: Response): Promise<void> {
  if (!isTrafficAdmin((req as any).user)) { forbid(res); return; }
  try {
    const q = req.query as Record<string, unknown>;
    const data = await trafficUsers({
      q: typeof q.q === 'string' ? q.q : undefined,
      sort: typeof q.sort === 'string' ? q.sort : undefined,
      dir: typeof q.dir === 'string' ? q.dir : undefined,
      page: Number(q.page) || 1,
      pageSize: Number(q.pageSize) || 25,
      kind: typeof q.kind === 'string' ? q.kind : undefined,
      channel: typeof q.channel === 'string' ? q.channel : undefined,
    });
    res.json({ success: true, data });
  } catch (err: any) {
    logger.error(`getTrafficUsers error: ${err?.message ?? err}`);
    res.status(500).json({ error: 'Failed to load users' });
  }
}

export async function getTrafficFlow(req: Request, res: Response): Promise<void> {
  if (!isTrafficAdmin((req as any).user)) { forbid(res); return; }
  const userId = typeof req.query.userId === 'string' ? req.query.userId.trim() : '';
  const visitorId = typeof req.query.visitorId === 'string' ? req.query.visitorId.trim() : '';
  if ((!userId && !visitorId) || (userId && !UUID_RE.test(userId)) || (visitorId && !UUID_RE.test(visitorId))) {
    res.status(400).json({ error: 'userId or visitorId (uuid) is required' });
    return;
  }
  try {
    const flow = await trafficFlow(userId ? { userId } : { visitorId: visitorId.toLowerCase() });
    if (!flow) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true, data: flow });
  } catch (err: any) {
    logger.error(`getTrafficFlow error: ${err?.message ?? err}`);
    res.status(500).json({ error: 'Failed to load user flow' });
  }
}
