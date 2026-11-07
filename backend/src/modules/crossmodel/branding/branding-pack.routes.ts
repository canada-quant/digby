/**
 * BRANDING PACK routes (todo 61dc8aaf, Phase 2 Cloud).
 *
 * TWO ROUTERS IN ONE FILE, and the split matters:
 *
 *  - `brandingPackPublicRoutes` is mounted BEFORE the app-level `authenticate`
 *    guard, because the visitors who must SEE the seasonal skin are anonymous.
 *    It exposes exactly two things: the ACTIVE pack's manifest (text + theme +
 *    asset metadata) and one active pack's asset BYTES. It never lists packs,
 *    never reads a draft, and never accepts a caller-supplied path — the only
 *    addressing is `packId` + `slot`, both validated against allowlists, so
 *    there is no filesystem or arbitrary-object read to jail. That is
 *    deliberately STRICTER than the self-host core's `DIGBY_BRANDING_DIR` route,
 *    which has to defend a real filesystem; here the "filesystem" is a column
 *    and the slot name is the index.
 *
 *  - `brandingPackAdminRoutes` is mounted after the guard and gates every handler
 *    on `isAdminViewer` — the ONE admin predicate (ADMIN role, or the owner
 *    e-mail on PRODUCTION only). Upload/validate/preview/activate/rollback all
 *    live here.
 *
 * WHY THE PUBLIC READ IS CACHEABLE-BUT-SHORT: a seasonal skin flipping on is a
 * deliberate, rare event, but when an operator activates it they expect to see it
 * on the next reload — so 60 s, matching the self-host asset route's own
 * `max-age=60`, not a long CDN TTL that would strand a rollback behind a purge.
 *
 * WHY ASSET BYTES ARE SERVED WITH `nosniff` + a locked CSP: the bytes came from
 * an upload. Even though only sniffed raster types are stored, the response is
 * hard-pinned to the stored Content-Type so a format confusion can never become
 * script execution on our origin. `Content-Security-Policy: default-src 'none'`
 * makes an image response inert even if it were somehow interpreted as a
 * document.
 */

import { Router, Response } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { AuthRequest } from '../../../middleware/auth';
import { validate } from '../../../middleware/validate';
import logger from '../../../utils/logger';
import { isAdminViewer } from '../view/view-mode';
import { MAX_PACK_ASSET_BYTES } from './image-sniff';
import {
  PACK_ASSET_SLOTS,
  PACK_LIMITS,
  PackConflictError,
  PackNotFoundError,
  PackValidationError,
  activatePack,
  createPack,
  deletePack,
  getActivePack,
  getActivePackAsset,
  listPacks,
  prepareAsset,
  rollbackToDefault,
  type PackAssetSlot,
} from './branding-pack.service';

/** The ONE admin predicate (mirrors org-admin.routes.ts). 403s without a user. */
function forbidUnlessAdmin(req: AuthRequest, res: Response): boolean {
  const user = req.user;
  if (!user || user.isChild === true || !isAdminViewer(user as any)) {
    res.status(403).json({ error: 'Forbidden: admin access required' });
    return true;
  }
  return false;
}

// ── upload parsing ──────────────────────────────────────────────────────────
/**
 * `memoryStorage` because the bytes are validated and then written to Postgres in
 * one step — a temp file would be a second place a rejected upload could linger.
 * The hard limit is enforced by multer BEFORE the request body reaches a handler,
 * so an oversized upload cannot be used to exhaust memory; `prepareAsset` then
 * re-checks the same ceiling (defence in depth, and it produces the operator-facing
 * message).
 */
const packUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PACK_ASSET_BYTES, files: PACK_ASSET_SLOTS.length },
}).any();

const SLOT_SET = new Set<string>(PACK_ASSET_SLOTS);

// ══ PUBLIC (mounted BEFORE the authenticate guard) ══════════════════════════
export const brandingPackPublicRoutes = Router();

/**
 * @swagger
 * /api/crossmodel/branding/pack:
 *   get:
 *     summary: The ACTIVE branding pack for this instance (public)
 *     description: >
 *       Returns `{ pack: null }` when no seasonal pack is active, which is the
 *       signal for every client to keep the shipped Digby identity. Anonymous
 *       by design — the whole point of a seasonal skin is that logged-out
 *       visitors see it too. Never exposes a draft, an archived pack, or bytes.
 *     tags: [crossmodel]
 */
brandingPackPublicRoutes.get('/branding/pack', async (_req, res, next) => {
  try {
    const pack = await getActivePack();
    // `no-store` is wrong here (the payload is tiny and read on every page load);
    // 60 s keeps a rollback visible immediately without a hot DB row per request.
    res.set('Cache-Control', 'public, max-age=60, must-revalidate');
    return res.json({ success: true, data: { pack } });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/branding/pack/{packId}/asset/{slot}:
 *   get:
 *     summary: One asset of the ACTIVE branding pack (public)
 *     description: >
 *       Serves the stored bytes for one validated slot. Reachable ONLY while the
 *       pack is active: `getActivePackAsset` filters on `pack.status = 'active'`,
 *       so a draft's or an archived pack's bytes are not readable through this
 *       route even with a known id and slot. `slot` is checked against the fixed
 *       slot allowlist, so there is no caller-controlled key beyond those names.
 *     tags: [crossmodel]
 */
brandingPackPublicRoutes.get('/branding/pack/:packId/asset/:slot', async (req, res, next) => {
  try {
    const { packId, slot } = req.params as { packId: string; slot: string };
    if (!SLOT_SET.has(slot)) return res.status(404).json({ error: 'Not found' });
    const asset = await getActivePackAsset(packId, slot as PackAssetSlot);
    if (!asset) return res.status(404).json({ error: 'Not found' });
    res.set({
      'Content-Type': asset.mimeType,
      'Content-Length': String(asset.data.length),
      // Immutable: the URL contains the pack id and the bytes for a given
      // (pack, slot) never change — a re-upload creates a new pack row.
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
      // The sha256 lets a deploy probe prove served bytes == validated bytes.
      ETag: `"${asset.sha256}"`,
    });
    return res.end(asset.data);
  } catch (error) {
    return next(error);
  }
});

// ══ ADMIN (mounted AFTER the authenticate guard) ════════════════════════════
export const brandingPackAdminRoutes = Router();

/**
 * @swagger
 * /api/crossmodel/admin/branding/packs:
 *   get:
 *     summary: List branding packs (admin only)
 *     description: >
 *       Metadata + asset inventory for every pack, newest first, active first.
 *       Bytes are never included — the admin panel previews through the public
 *       asset route, so what an operator previews is exactly what a visitor gets.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
brandingPackAdminRoutes.get('/admin/branding/packs', async (req, res, next) => {
  try {
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const packs = await listPacks();
    return res.json({
      success: true,
      data: {
        packs,
        activePackId: packs.find((p) => p.status === 'active')?.id ?? null,
        slots: PACK_ASSET_SLOTS,
        limits: PACK_LIMITS,
        maxAssetBytes: MAX_PACK_ASSET_BYTES,
      },
    });
  } catch (error) {
    return next(error);
  }
});

const createSchema = z.object({
  body: z.object({
    name: z.string().min(1).max(PACK_LIMITS.packNameMax),
    description: z.string().max(PACK_LIMITS.packDescriptionMax).nullish(),
    manifest: z.unknown().optional(),
  }),
});

/**
 * @swagger
 * /api/crossmodel/admin/branding/packs:
 *   post:
 *     summary: Create a branding pack, optionally with assets (admin only)
 *     description: >
 *       Accepts multipart/form-data: `name`, `description`, `manifest` (JSON
 *       string) and one file per asset slot, each named by its slot
 *       (`logo`, `logoDark`, `spinner`, …). EVERY file is validated before
 *       anything is stored: the type is decided by magic bytes (never the
 *       upload's own Content-Type), the dimensions must be readable and inside
 *       the slot's bounds, SVG is refused, and the ceiling is 2 MB per asset.
 *       On a rejected asset the response is 400 with one message per bad slot
 *       and NOTHING is created — a half-valid pack can never exist.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
brandingPackAdminRoutes.post(
  '/admin/branding/packs',
  packUpload,
  validate(createSchema),
  async (req, res, next) => {
    try {
      if (forbidUnlessAdmin(req as AuthRequest, res)) return;
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      const body = req.body as { name: string; description?: string | null; manifest?: unknown };

      // `manifest` arrives as a JSON string on a multipart request.
      let manifest: unknown = body.manifest;
      if (typeof manifest === 'string') {
        try {
          manifest = JSON.parse(manifest);
        } catch {
          return res.status(400).json({ error: 'manifest must be valid JSON' });
        }
      }

      // Validate EVERY file first, collecting all rejections so an operator fixes
      // the whole batch in one pass instead of one file per round trip.
      const prepared = [];
      const rejections: { slot: string; reason: string }[] = [];
      const seen = new Set<string>();
      for (const file of files) {
        const slot = String(file.fieldname || '');
        if (!SLOT_SET.has(slot)) {
          rejections.push({ slot, reason: `"${slot}" is not a branding asset slot` });
          continue;
        }
        if (seen.has(slot)) {
          rejections.push({ slot, reason: `two files were uploaded for "${slot}"` });
          continue;
        }
        seen.add(slot);
        const result = prepareAsset(slot as PackAssetSlot, file.buffer);
        if (result.ok) prepared.push(result.asset);
        else rejections.push({ slot, reason: result.rejection.reason });
      }
      if (rejections.length) {
        return res.status(400).json({
          error: 'One or more assets failed validation — nothing was saved.',
          rejections,
        });
      }

      const pack = await createPack({
        name: body.name,
        description: body.description ?? null,
        manifest,
        assets: prepared,
        createdById: (req as AuthRequest).user?.id ?? null,
      });
      logger.info(
        `branding-pack: created "${pack.name}" (${pack.id}, ${prepared.length} asset(s)) by ${(req as AuthRequest).user?.id ?? 'unknown'}`,
      );
      return res.status(201).json({ success: true, data: { pack } });
    } catch (error) {
      return handlePackError(error, res, next);
    }
  },
);

const idParams = z.object({ params: z.object({ packId: z.string().min(1) }) });

/**
 * @swagger
 * /api/crossmodel/admin/branding/packs/{packId}/activate:
 *   post:
 *     summary: Activate a branding pack (admin only)
 *     description: >
 *       Puts the pack live for every visitor, atomically. Any previously active
 *       pack is archived in the same transaction, and a partial unique index in
 *       the database guarantees at most one active pack even under a concurrent
 *       double-click. Refuses (400) when the pack lacks a logo, or an animated
 *       spinner without its static twin.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
brandingPackAdminRoutes.post('/admin/branding/packs/:packId/activate', validate(idParams), async (req, res, next) => {
  try {
    const admin = (req as AuthRequest).user;
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const { packId } = req.params as { packId: string };
    const pack = await activatePack(packId);
    logger.info(`branding-pack: ACTIVATED "${pack.name}" (${pack.id}) by ${admin?.id ?? 'unknown'}`);
    return res.json({ success: true, data: { pack } });
  } catch (error) {
    return handlePackError(error, res, next);
  }
});

/**
 * @swagger
 * /api/crossmodel/admin/branding/packs/rollback:
 *   post:
 *     summary: Roll back to the shipped Digby branding (admin only)
 *     description: >
 *       Clears the active pack. There is no previous-pack bookkeeping: with no
 *       active row every surface falls back to the shipped Digby identity, so
 *       this is the one-step undo and the safe direction. Idempotent — calling it
 *       with nothing active returns rolledBack 0.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
brandingPackAdminRoutes.post('/admin/branding/packs/rollback', async (req, res, next) => {
  try {
    const admin = (req as AuthRequest).user;
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const result = await rollbackToDefault();
    logger.info(`branding-pack: ROLLBACK to shipped branding (${result.rolledBack} archived) by ${admin?.id ?? 'unknown'}`);
    return res.json({ success: true, data: result });
  } catch (error) {
    return next(error);
  }
});

/**
 * @swagger
 * /api/crossmodel/admin/branding/packs/{packId}:
 *   delete:
 *     summary: Delete a branding pack (admin only)
 *     description: >
 *       Removes the pack and its assets. The ACTIVE pack cannot be deleted (400) —
 *       roll back first — so "delete" is never the accident that unbrands the site.
 *     tags: [crossmodel]
 *     security:
 *       - bearerAuth: []
 *       - cookieAuth: []
 */
brandingPackAdminRoutes.delete('/admin/branding/packs/:packId', validate(idParams), async (req, res, next) => {
  try {
    const admin = (req as AuthRequest).user;
    if (forbidUnlessAdmin(req as AuthRequest, res)) return;
    const { packId } = req.params as { packId: string };
    const result = await deletePack(packId);
    logger.info(`branding-pack: deleted ${packId} by ${admin?.id ?? 'unknown'}`);
    return res.json({ success: true, data: result });
  } catch (error) {
    return handlePackError(error, res, next);
  }
});

/**
 * Map the service's typed refusals to statuses, so the admin panel can show the
 * operator's own words instead of a generic 500. A multer size-limit error is
 * also translated here (it is thrown before the handler body runs).
 */
function handlePackError(error: unknown, res: Response, next: (e?: unknown) => void) {
  if (error instanceof PackValidationError) return res.status(400).json({ error: error.message });
  if (error instanceof PackNotFoundError) return res.status(404).json({ error: error.message });
  if (error instanceof PackConflictError) return res.status(409).json({ error: error.message });
  if ((error as any)?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `An asset is too large — the limit is ${MAX_PACK_ASSET_BYTES / 1024} KB per file.` });
  }
  if ((error as any)?.code === 'LIMIT_FILE_COUNT' || (error as any)?.code === 'LIMIT_UNEXPECTED_FILE') {
    return res.status(400).json({ error: 'Too many files — one file per branding asset slot.' });
  }
  return next(error);
}

export default brandingPackAdminRoutes;