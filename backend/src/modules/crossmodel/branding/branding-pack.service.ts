/**
 * Seasonal/holiday BRANDING PACKS — Cloud layer on the shared branding core
 * (todo 61dc8aaf, Phase 2).
 *
 * THE PRODUCT IDEA, in the owner's terms: digby.ai should wear a seasonal skin
 * — a holiday name, a winter logo, a snowflake spinner — and an operator should
 * be able to put it on and take it off from the admin panel, at runtime, with no
 * frontend fork and no rebuild. The self-hosted core (todo d2d32b57) already
 * knows how to RENDER a rebrand; what it cannot do is change one at runtime on
 * Cloud, because it reads build-time env and an operator-mounted directory that
 * the Cloud frontend container does not have.
 *
 * SO THIS FILE OWNS THREE THINGS:
 *
 *  1. VALIDATION — an uploaded pack becomes a `Branding`-shaped manifest plus a
 *     set of binary assets, every one of them proven to be a real image by magic
 *     bytes (see image-sniff.ts) and dimension-checked against its slot. A pack
 *     that fails any check is stored as a DRAFT with the failures recorded, or
 *     refused outright on upload — it never becomes servable half-valid.
 *
 *  2. THE ONE-ACTIVE INVARIANT — at most one pack is 'active' at any instant.
 *     This is guaranteed by a PARTIAL UNIQUE INDEX in Postgres, not by this
 *     file's good behaviour: `activatePack` deactivates-then-activates inside one
 *     transaction, and if two requests race, the loser hits a unique violation
 *     and is retried as a clean "someone else just activated" rather than leaving
 *     two rows active.
 *
 *  3. ROLLBACK — reactivating nothing at all. `rollbackToDefault()` clears every
 *     'active' row in one statement, which is the whole mechanism: with no active
 *     row the public endpoint reports `{ pack: null }` and the frontend falls
 *     straight back to the shipped Digby identity. Default branding is therefore
 *     recoverable by construction — there is no code path where an operator has
 *     to "undo" an upload to get the Digby logo back.
 *
 * WHY THE MANIFEST IS VALIDATED, NOT TRUSTED: `manifest` is JSONB written from an
 * HTTP body. It is re-run through the SAME sanitisers the env-based core uses
 * (`cleanText`/`cleanHex` equivalents below — the frontend lib is not importable
 * from the backend, so the rules are mirrored and pinned by a test that reads
 * both sources). A pack value that cannot pass a sanitiser is dropped, not
 * stored: the public endpoint must never be the first place a bad value is
 * discovered.
 */

import crypto from 'crypto';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import {
  DEFAULT_PACK_MANIFEST,
  PACK_ASSET_SLOTS,
  PACK_LIMITS,
  SLOT_RULES,
  cleanPackHex,
  cleanPackText,
  missingForActivation,
  normalizeManifest,
  prepareAsset,
  type AssetRejection,
  type PackAssetSlot,
  type PackManifest,
  type PrepareResult,
  type PreparedAsset,
} from './pack-validation';

// Re-exported so route/caller imports keep ONE path (`branding-pack.service`) for
// both the I/O functions and the validation rules they enforce.
export {
  DEFAULT_PACK_MANIFEST,
  PACK_ASSET_SLOTS,
  PACK_LIMITS,
  SLOT_RULES,
  cleanPackHex,
  cleanPackText,
  missingForActivation,
  normalizeManifest,
  prepareAsset,
};
export type { AssetRejection, PackAssetSlot, PackManifest, PrepareResult, PreparedAsset };

/** The public, cache-safe projection of an asset (never includes bytes). */
export interface PublicPackAsset {
  slot: PackAssetSlot;
  mimeType: string;
  width: number | null;
  height: number | null;
  sha256: string;
  sizeBytes: number;
}

export interface PublicPack {
  id: string;
  name: string;
  manifest: PackManifest;
  assets: PublicPackAsset[];
  activatedAt: string | null;
}

/**
 * Create a DRAFT pack. Assets are optional at creation so an operator can save a
 * text-only seasonal theme; a pack is only servable once ACTIVATED, and
 * activation runs the completeness check.
 */
export async function createPack(input: {
  name: string;
  description?: string | null;
  manifest: unknown;
  assets: PreparedAsset[];
  createdById?: string | null;
}) {
  const name = cleanPackText(input.name, '', PACK_LIMITS.packNameMax);
  if (!name) throw new PackValidationError('A pack needs a name (1–80 characters).');
  const manifest = normalizeManifest(input.manifest);

  // An empty name means the operator sent something unsanitisable — refuse the
  // pack instead of shipping "+   " as a seasonal brand.
  if (manifest.name === DEFAULT_PACK_MANIFEST.name && input.manifest && (input.manifest as any).name) {
    throw new PackValidationError(
      `The brand name "${String((input.manifest as any).name).slice(0, 40)}" is not valid — use 1–${PACK_LIMITS.nameMax} characters, no angle brackets.`,
    );
  }

  const seen = new Set<string>();
  for (const a of input.assets) {
    if (seen.has(a.slot)) throw new PackValidationError(`Two files were uploaded for the "${a.slot}" slot.`);
    seen.add(a.slot);
  }

  return prisma.$transaction(async (tx) => {
    const pack = await tx.brandingPack.create({
      data: {
        name,
        description: input.description ? cleanPackText(input.description, '', PACK_LIMITS.packDescriptionMax) || null : null,
        status: 'draft',
        manifest: manifest as unknown as object,
        createdById: input.createdById ?? null,
      },
    });
    // Assets are written as their own rows rather than a nested create: `data` is
    // a Buffer going into a Postgres bytea column, and the nested-create form
    // widens the union Prisma accepts for `Bytes` in a way that neither the
    // generated types nor the runtime adapter likes. Two plain creates inside one
    // transaction give the same all-or-nothing result.
    for (const a of input.assets) {
      await tx.brandingPackAsset.create({
        data: {
          packId: pack.id,
          slot: a.slot,
          mimeType: a.mimeType,
          sizeBytes: a.sizeBytes,
          width: a.width,
          height: a.height,
          sha256: a.sha256,
          // Prisma's `Bytes` accepts `Uint8Array<ArrayBuffer>`, while a Node
          // `Buffer` is `Uint8Array<ArrayBufferLike>` (it may be a view over a
          // shared pool), so the two do not mutually assign. Copying into a plain
          // `Uint8Array` gives an `ArrayBuffer`-backed value of exactly the
          // expected type — no cast, and the stored bytes are a snapshot that
          // cannot be mutated by whoever still holds the upload buffer.
          data: new Uint8Array(a.data),
        },
      });
    }
    return tx.brandingPack.findUniqueOrThrow({
      where: { id: pack.id },
      include: { assets: { select: ASSET_PROJECTION } },
    });
  });
}

const ASSET_PROJECTION = {
  id: true,
  slot: true,
  mimeType: true,
  sizeBytes: true,
  width: true,
  height: true,
  sha256: true,
} as const;

/** A typed refusal so the route layer can answer 400 with the operator's words. */
export class PackValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackValidationError';
  }
}

/**
 * Activate a pack, atomically. The partial unique index on status='active' is the
 * real guarantee; this transaction just keeps the audit fields coherent.
 *
 * A unique violation here means ANOTHER activation won the race a moment ago, so
 * it is surfaced as a typed conflict rather than a 500 — the operator retries and
 * sees the pack that actually went live.
 */
export async function activatePack(packId: string) {
  const pack = await prisma.brandingPack.findUnique({
    where: { id: packId },
    include: { assets: { select: ASSET_PROJECTION } },
  });
  if (!pack) throw new PackNotFoundError();

  const missing = missingForActivation(pack.assets.map((a) => a.slot));
  if (missing.length) {
    throw new PackValidationError(
      `This pack cannot go live yet — it is missing: ${missing.join(', ')}. Upload the missing asset(s) first.`,
    );
  }

  try {
    return await prisma.$transaction(async (tx) => {
      // Clear first so the unique index has room. One statement, so no window
      // where two rows are active from this transaction's point of view.
      await tx.brandingPack.updateMany({
        where: { status: 'active', NOT: { id: packId } },
        data: { status: 'archived', activatedAt: null },
      });
      return tx.brandingPack.update({
        where: { id: packId },
        data: { status: 'active', activatedAt: new Date() },
        include: { assets: { select: ASSET_PROJECTION } },
      });
    });
  } catch (error: any) {
    if (error?.code === 'P2002') {
      throw new PackConflictError('Another pack was activated at the same moment. Reload the list and try again.');
    }
    throw error;
  }
}

/**
 * Roll back to the shipped Digby identity: no active pack at all.
 *
 * This is the whole rollback mechanism, and it is deliberately one UPDATE: there
 * is no "restore the previous pack" bookkeeping to get wrong, and no way for a
 * half-applied rollback to leave the site branded with a pack nobody selected.
 * The deactivated pack stays as an ARCHIVED row, so re-activating it later is one
 * click, not a re-upload.
 */
export async function rollbackToDefault() {
  const res = await prisma.brandingPack.updateMany({
    where: { status: 'active' },
    data: { status: 'archived', activatedAt: null },
  });
  if (res.count) logger.info(`branding-pack: rolled back to shipped branding (${res.count} pack(s) archived)`);
  return { rolledBack: res.count };
}

/** Delete a pack and its assets. The ACTIVE pack cannot be deleted — roll back
 *  first, so "delete" can never be the accident that unbrands the site. */
export async function deletePack(packId: string) {
  const pack = await prisma.brandingPack.findUnique({ where: { id: packId }, select: { id: true, status: true } });
  if (!pack) throw new PackNotFoundError();
  if (pack.status === 'active') {
    throw new PackValidationError('This pack is live. Roll back to the default branding before deleting it.');
  }
  await prisma.brandingPack.delete({ where: { id: packId } });
  return { deleted: true };
}

/**
 * The ACTIVE pack as the public endpoint serves it. `null` means "no seasonal
 * pack is on right now" and the client keeps the shipped Digby identity — the
 * default is never represented as a pack, so it can never be accidentally
 * deleted or half-loaded.
 */
export async function getActivePack(): Promise<PublicPack | null> {
  const pack = await prisma.brandingPack.findFirst({
    where: { status: 'active' },
    include: { assets: { select: ASSET_PROJECTION } },
    orderBy: { activatedAt: 'desc' },
  });
  if (!pack) return null;
  return {
    id: pack.id,
    name: pack.name,
    manifest: normalizeManifest(pack.manifest),
    assets: (pack.assets as any[]).map((a) => ({
      slot: a.slot as PackAssetSlot,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      sha256: a.sha256,
      sizeBytes: a.sizeBytes,
    })),
    activatedAt: pack.activatedAt ? pack.activatedAt.toISOString() : null,
  };
}

/** One asset's bytes for the public route. Returns null when the pack is not
 *  ACTIVE — a draft's assets are never publicly readable. */
export async function getActivePackAsset(packId: string, slot: string): Promise<{ data: Buffer; mimeType: string; sha256: string } | null> {
  const row = await prisma.brandingPackAsset.findFirst({
    where: { packId, slot, pack: { status: 'active' } },
    select: { data: true, mimeType: true, sha256: true },
  });
  if (!row) return null;
  return { data: Buffer.from(row.data), mimeType: row.mimeType, sha256: row.sha256 };
}

/** One row of the admin list — metadata only, never the bytes. */
export interface AdminPackRow {
  id: string;
  name: string;
  description: string | null;
  status: string;
  manifest: PackManifest;
  assets: PublicPackAsset[];
  createdAt: string;
  updatedAt: string;
  activatedAt: string | null;
}

/** Admin list — metadata only, never the bytes. */
export async function listPacks(): Promise<AdminPackRow[]> {
  const packs = await prisma.brandingPack.findMany({
    include: { assets: { select: ASSET_PROJECTION } },
    orderBy: [{ status: 'asc' }, { createdAt: 'desc' }],
  });
  return packs.map((p) => ({
    id: p.id,
    name: p.name,
    description: p.description,
    status: p.status,
    manifest: normalizeManifest(p.manifest),
    assets: (p.assets as any[]).map((a) => ({
      slot: a.slot as PackAssetSlot,
      mimeType: a.mimeType,
      width: a.width,
      height: a.height,
      sha256: a.sha256,
      sizeBytes: a.sizeBytes,
    })),
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    activatedAt: p.activatedAt ? p.activatedAt.toISOString() : null,
  }));
}

export class PackNotFoundError extends Error {
  constructor() {
    super('No such branding pack.');
    this.name = 'PackNotFoundError';
  }
}

export class PackConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackConflictError';
  }
}