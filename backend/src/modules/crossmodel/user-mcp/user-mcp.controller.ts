/**
 * User-added MCP servers (ticket e294f9a4) — thin HTTP transport over
 * user-mcp.service.ts (model-endpoints.controller.ts style: try/catch →
 * next(error), AppError carries the status). Every route is the CALLER'S OWN
 * servers (user id from the JWT) — there is no admin surface: a server, its
 * token and its tools belong to one user. The service is imported lazily so
 * mounting the router stays import-light (route-posture.test mounts the real
 * route files).
 */

import { Response, NextFunction } from 'express';
import { AuthRequest } from '../../../middleware/auth';

const svc = () => import('./user-mcp.service');

function userIdOf(req: AuthRequest, res: Response): string | null {
  const id = req.user?.id || req.user?.userId;
  if (!id) { res.status(401).json({ error: 'Unauthorized' }); return null; }
  return id;
}

class UserMcpController {
  /** GET /mcp-servers — the caller's servers (health + cached tools; never a token or a secret URL). */
  async list(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { listServers } = await svc();
      res.json({ success: true, data: { servers: await listServers(userId) } });
    } catch (error) { next(error); }
  }

  /** GET /mcp-servers/templates — the quick-start catalog. */
  async templates(_req: AuthRequest, res: Response, next: NextFunction) {
    try {
      const { userMcpDisabled } = await import('./user-mcp-tools');
      if (userMcpDisabled()) { res.status(404).json({ error: 'MCP servers are switched off on this instance.' }); return; }
      const { MCP_SERVER_TEMPLATES } = await import('./user-mcp-templates');
      res.json({ success: true, data: { templates: MCP_SERVER_TEMPLATES } });
    } catch (error) { next(error); }
  }

  /** POST /mcp-servers — add (then probe at once: tools cached before the next turn). */
  async create(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { createServer } = await svc();
      res.status(201).json({ success: true, data: await createServer(userId, req.body) });
    } catch (error) { next(error); }
  }

  /** POST /mcp-servers/test — probe a DRAFT (nothing stored). */
  async testDraft(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { testDraft } = await svc();
      res.json({ success: true, data: { probe: await testDraft(userId, req.body) } });
    } catch (error) { next(error); }
  }

  /** PATCH /mcp-servers/:id — partial update (authValue '' clears the token; a changed URL / token re-probes). */
  async update(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { updateServer } = await svc();
      const out = await updateServer(userId, String(req.params.id), req.body);
      if (!out) { res.status(404).json({ error: 'MCP server not found' }); return; }
      res.json({ success: true, data: out });
    } catch (error) { next(error); }
  }

  /** POST /mcp-servers/:id/test — live probe of a saved server (records health, refreshes the tool list). */
  async test(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { testServer } = await svc();
      const out = await testServer(userId, String(req.params.id));
      if (!out) { res.status(404).json({ error: 'MCP server not found' }); return; }
      res.json({ success: true, data: out });
    } catch (error) { next(error); }
  }

  /** DELETE /mcp-servers/:id */
  async remove(req: AuthRequest, res: Response, next: NextFunction) {
    const userId = userIdOf(req, res); if (!userId) return;
    try {
      const { deleteServer } = await svc();
      if (!(await deleteServer(userId, String(req.params.id)))) { res.status(404).json({ error: 'MCP server not found' }); return; }
      res.json({ success: true });
    } catch (error) { next(error); }
  }
}

export default new UserMcpController();
