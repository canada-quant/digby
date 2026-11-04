/**
 * GET / PUT /api/crossmodel/view-mode (minimal view, 2026-10-16 — see view-mode.ts).
 *   GET → { viewMode, isAdmin, debugMode } for the caller (debugMode is null for a non-admin).
 *   PUT { debugMode: boolean } → admins only; flips what THIS admin sees (full ⇄ minimal).
 */

import type { Request, Response, NextFunction } from 'express';
import { getDebugMode, isAdminViewer, resolveViewMode, resolveViewModeForRequest, setDebugMode } from './view-mode';

export async function getViewMode(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user as any;
    const isAdmin = isAdminViewer(user);
    res.json({
      success: true,
      data: {
        viewMode: await resolveViewModeForRequest(req as any),
        isAdmin,
        debugMode: isAdmin && user?.id ? await getDebugMode(user.id) : null,
      },
    });
  } catch (err) {
    next(err);
  }
}

export async function putViewMode(req: Request, res: Response, next: NextFunction) {
  try {
    const user = req.user as any;
    if (!isAdminViewer(user)) return res.status(403).json({ success: false, message: 'Debug mode is for admins only' });
    const { debugMode } = (req.body || {}) as { debugMode?: unknown };
    if (typeof debugMode !== 'boolean') return res.status(400).json({ success: false, message: 'debugMode must be a boolean' });
    await setDebugMode(user.id, debugMode);
    res.json({ success: true, data: { viewMode: await resolveViewMode(user), isAdmin: true, debugMode } });
  } catch (err) {
    next(err);
  }
}
