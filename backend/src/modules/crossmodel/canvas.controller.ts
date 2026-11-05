import { Request, Response, NextFunction } from 'express';
import { randomBytes } from 'crypto';
import prisma from '../../config/database';
import logger from '../../utils/logger';

/** Minimal HTML escape for wrapping non-HTML artifacts in a public page. */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export class CanvasController {
  /**
   * GET /api/crossmodel/canvases
   * List ALL canvas documents for the authenticated user (across all chats)
   * Includes chat title and project info for display in Files section
   */
  async listAll(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;

      const canvases = await prisma.canvasDocument.findMany({
        where: { userId },
        include: {
          chat: {
            select: {
              id: true,
              title: true,
              projectId: true,
              project: {
                select: { id: true, name: true, emoji: true },
              },
            },
          },
        },
        orderBy: { createdAt: 'desc' },
      });

      res.json({ success: true, data: canvases });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/chats/:id/canvases
   * List all canvas documents for a specific chat (includes full content for panel restore)
   */
  async listCanvases(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id: chatId } = req.params;

      // Verify user owns or can access this chat
      const chat = await prisma.crossModelChat.findFirst({
        where: { id: chatId, userId },
        select: { id: true },
      });

      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      // Return full canvas including content — needed to restore canvas panel when reopening a chat
      const canvases = await prisma.canvasDocument.findMany({
        where: { chatId, userId },
        orderBy: { createdAt: 'asc' },
      });

      res.json({ success: true, data: canvases });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/crossmodel/canvases/:id
   * Get a single canvas with full content
   */
  async getCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      const canvas = await prisma.canvasDocument.findFirst({
        where: { id, userId },
      });

      if (!canvas) {
        return res.status(404).json({ error: 'Canvas not found' });
      }

      res.json({ success: true, data: canvas });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/crossmodel/chats/:id/canvases
   * Create a canvas manually (user-initiated or AI-created)
   */
  async createCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id: chatId } = req.params;
      const { title, type = 'document', language, content } = req.body;

      if (!title || content === undefined) {
        return res.status(400).json({ error: 'title and content are required' });
      }

      // Verify chat ownership
      const chat = await prisma.crossModelChat.findFirst({
        where: { id: chatId, userId },
        select: { id: true },
      });

      if (!chat) {
        return res.status(404).json({ error: 'Chat not found' });
      }

      const canvas = await prisma.canvasDocument.create({
        data: {
          chatId,
          userId,
          title,
          type,
          language: language || null,
          content,
          version: 1,
        },
      });

      logger.info(`Canvas created: ${canvas.id} (type: ${type}) for chat ${chatId}`);

      res.status(201).json({ success: true, data: canvas });
    } catch (error) {
      next(error);
    }
  }

  /**
   * PUT /api/crossmodel/canvases/:id
   * Update canvas content (user editing or AI refining)
   * Increments version number on each save
   */
  async updateCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const { title, content, language } = req.body;

      const existing = await prisma.canvasDocument.findFirst({
        where: { id, userId },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Canvas not found' });
      }

      const updated = await prisma.canvasDocument.update({
        where: { id },
        data: {
          ...(title !== undefined && { title }),
          ...(content !== undefined && { content }),
          ...(language !== undefined && { language }),
          version: existing.version + 1,
        },
      });

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/crossmodel/canvases/:id
   * Delete a canvas document
   */
  async deleteCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;

      const existing = await prisma.canvasDocument.findFirst({
        where: { id, userId },
        select: { id: true },
      });

      if (!existing) {
        return res.status(404).json({ error: 'Canvas not found' });
      }

      await prisma.canvasDocument.delete({ where: { id } });

      res.json({ success: true, message: 'Canvas deleted' });
    } catch (error) {
      next(error);
    }
  }

  // ── Public canvas sharing ────────────────────────────────────────────────
  // ARCHITECTURE (future-proofing, owner-directed 2026-07-19): shared artifacts
  // are served straight from the canvas_documents row through THIS backend —
  // one service for every chat's artifacts. No per-project containers, no
  // per-chat services: a share is a DB row, so "too many running services"
  // can never happen.

  /**
   * POST /api/crossmodel/canvases/:id/share — create (or re-activate) the
   * public link for a canvas. One link per canvas; token survives re-shares.
   */
  async shareCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const canvas = await prisma.canvasDocument.findFirst({ where: { id, userId }, select: { id: true, title: true } });
      if (!canvas) return res.status(404).json({ error: 'Canvas not found' });
      const link = await (prisma as any).canvasShareLink.upsert({
        where: { canvasId: id },
        create: { canvasId: id, shareToken: randomBytes(20).toString('hex'), isActive: true },
        update: { isActive: true },
      });
      logger.info(`canvas share: user ${userId.slice(0, 8)} shared canvas ${id.slice(0, 8)}`);
      res.json({ success: true, data: { shareToken: link.shareToken, url: `/api/crossmodel/shared/canvas/${link.shareToken}` } });
    } catch (error) { next(error); }
  }

  /** DELETE /api/crossmodel/canvases/:id/share — revoke the public link. */
  async revokeCanvasShare(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const canvas = await prisma.canvasDocument.findFirst({ where: { id, userId }, select: { id: true } });
      if (!canvas) return res.status(404).json({ error: 'Canvas not found' });
      await (prisma as any).canvasShareLink.updateMany({ where: { canvasId: id }, data: { isActive: false } });
      res.json({ success: true });
    } catch (error) { next(error); }
  }

  /** GET /api/crossmodel/canvases/:id/share — current share status. */
  async getCanvasShareStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user!.id;
      const { id } = req.params;
      const canvas = await prisma.canvasDocument.findFirst({ where: { id, userId }, select: { id: true } });
      if (!canvas) return res.status(404).json({ error: 'Canvas not found' });
      const link = await (prisma as any).canvasShareLink.findUnique({ where: { canvasId: id } });
      res.json({ success: true, data: link && link.isActive ? { shared: true, shareToken: link.shareToken, url: `/api/crossmodel/shared/canvas/${link.shareToken}` } : { shared: false } });
    } catch (error) { next(error); }
  }

  /**
   * GET /api/crossmodel/shared/canvas/:token — PUBLIC (no auth): serve the
   * artifact as a real web page anyone can open. HTML artifacts run as-is in
   * a sandboxed document; every other type gets a minimal escaped wrapper.
   */
  async getSharedCanvas(req: Request, res: Response, next: NextFunction) {
    try {
      const { token } = req.params;
      if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return res.status(404).send('Not found');
      // SEPARATE-ORIGIN isolation (defense against on-brand phishing): user HTML
      // runs sandboxed (no allow-same-origin → can't touch digby.ai cookies/
      // storage), but arbitrary JS under the trusted apex URL is still a
      // social-engineering risk. When SHARED_CANVAS_HOST is set (e.g.
      // usercontent.digby.ai), serve ONLY from there and redirect apex hits —
      // the standard githubusercontent.com / googleusercontent.com pattern.
      const isolatedHost = process.env.SHARED_CANVAS_HOST;
      if (isolatedHost && req.hostname !== isolatedHost) {
        return res.redirect(302, `https://${isolatedHost}/api/crossmodel/shared/canvas/${token}`);
      }
      const link = await (prisma as any).canvasShareLink.findUnique({
        where: { shareToken: token },
        include: { canvas: { select: { title: true, type: true, language: true, content: true, updatedAt: true } } },
      });
      if (!link || !link.isActive || !link.canvas) return res.status(410).send('This shared artifact is no longer available.');
      const c = link.canvas;
      // Isolate the page: scripts may run (that's the point of sharing an app)
      // but the document gets no credentials/origin powers on digby.ai.
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals; frame-ancestors *");
      res.setHeader('X-Robots-Tag', 'noindex');
      res.setHeader('Referrer-Policy', 'no-referrer');
      res.setHeader('Cache-Control', 'public, max-age=60');
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      if (c.type === 'html') return res.send(c.content);
      const body = c.type === 'document'
        ? `<div style="white-space:pre-wrap;font:16px/1.6 system-ui,sans-serif;max-width:760px;margin:40px auto;padding:0 20px">${esc(c.content)}</div>`
        : `<pre style="font:13px/1.5 ui-monospace,Menlo,monospace;max-width:920px;margin:40px auto;padding:16px;background:#f6f6f4;border-radius:8px;overflow-x:auto">${esc(c.content)}</pre>`;
      return res.send(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(c.title)}</title></head><body style="margin:0;background:#fff;color:#1c1a22">${body}</body></html>`);
    } catch (error) { next(error); }
  }
}

export default new CanvasController();
