/**
 * CONTRACT pins — backend pack rules vs the frontend branding core
 * (todo 61dc8aaf, Phase 2 Cloud).
 *
 * The pack validator MIRRORS the shared branding core's rules instead of
 * importing them (the frontend library is not on the backend's module path). A
 * mirror is a copy, and a copy drifts. So this file reads BOTH SOURCES and fails
 * when they disagree — which is the only thing that keeps "a pack value is
 * validated exactly like a DIGBY_BRAND_* value" true a year from now.
 *
 * It also pins the two structural decisions a future edit could quietly undo:
 *  - the coupling between the pack and the ROUTER MOUNTS (public before the
 *    guard, admin after it) — the whole reason an anonymous visitor sees the
 *    seasonal skin;
 *  - that the migration keeps the DB-level one-active guarantee. If that index
 *    were dropped, the atomicity of "activate" would silently fall back to
 *    application logic.
 */
import { describe, it, expect } from '@jest/globals';
import fs from 'fs';
import path from 'path';
import { PACK_ASSET_SLOTS, PACK_LIMITS } from './pack-validation';

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const REPO_ROOT = path.resolve(BACKEND_ROOT, '..');
const FRONTEND_CORE = path.join(REPO_ROOT, 'frontend', 'lib', 'branding', 'index.ts');
const FRONTEND_PACK = path.join(REPO_ROOT, 'frontend', 'lib', 'branding', 'pack.ts');
const APP_TS = path.join(BACKEND_ROOT, 'src', 'app.ts');
const MIGRATION = path.join(
  BACKEND_ROOT,
  'prisma',
  'migrations',
  '20261107093000_phase2_cloud_branding_packs',
  'migration.sql',
);

const read = (p: string): string => fs.readFileSync(p, 'utf8');

describe('pack asset slots — one vocabulary across the stack', () => {
  it('every backend slot is a real BrandingAssets key in the frontend core', () => {
    const core = read(FRONTEND_CORE);
    // The interface block is the source of truth; assert each name appears as a
    // property declaration inside it rather than anywhere in the file.
    const start = core.indexOf('export interface BrandingAssets');
    expect(start).toBeGreaterThan(-1);
    const block = core.slice(start, core.indexOf('}', start));
    for (const slot of PACK_ASSET_SLOTS) {
      expect(block).toContain(`${slot}:`);
    }
  });

  it('the frontend pack module declares the SAME slot list', () => {
    const src = read(FRONTEND_PACK);
    for (const slot of PACK_ASSET_SLOTS) {
      expect(src).toContain(`'${slot}'`);
    }
    // And the counts match, so the frontend list cannot be a superset.
    const declared = src.match(/export const PACK_SLOTS = \[([\s\S]*?)\] as const;/);
    expect(declared).not.toBeNull();
    const names = (declared as RegExpMatchArray)[1].match(/'[a-zA-Z0-9]+'/g) ?? [];
    expect(names.map((n) => n.replace(/'/g, ''))).toEqual([...PACK_ASSET_SLOTS]);
  });
});

describe('text caps — the pack refuses what the core refuses', () => {
  it('every numeric cap matches the frontend core constant', () => {
    const core = read(FRONTEND_CORE);
    const pairs: Array<[string, number]> = [
      ['NAME_MAX', PACK_LIMITS.nameMax],
      ['SHORT_NAME_MAX', PACK_LIMITS.shortNameMax],
      ['TAGLINE_MAX', PACK_LIMITS.taglineMax],
      ['DESCRIPTION_MAX', PACK_LIMITS.descriptionMax],
      ['ALT_MAX', PACK_LIMITS.logoAltMax],
      ['TITLE_SUFFIX_MAX', PACK_LIMITS.titleSuffixMax],
    ];
    for (const [name, value] of pairs) {
      const m = core.match(new RegExp(`export const ${name} = (\\d+);`));
      if (!m) throw new Error(`${name} not found in the frontend core`);
      expect(Number(m[1])).toBe(value);
    }
  });

  it('both sanitisers strip control chars and angle brackets (no markup injection)', () => {
    const core = read(FRONTEND_CORE);
    // The rule, not the implementation: a value must never be able to carry `<`.
    expect(core).toContain('\\u0000-\\u001f\\u007f<>');
    const backend = read(path.join(__dirname, 'pack-validation.ts'));
    expect(backend).toContain('\\u0000-\\u001f\\u007f<>');
  });
});

describe('route posture — the public read MUST sit before the auth guard', () => {
  const appSource = read(APP_TS);

  it('mounts the public pack router before the single guard', () => {
    const guard = appSource.indexOf("mountApi(app, '', authenticate)");
    const pub = appSource.indexOf("mountApi(app, '', brandingPackPublicRoutes)");
    expect(guard).toBeGreaterThan(-1);
    expect(pub).toBeGreaterThan(-1);
    // An anonymous visitor must be able to read the active pack; behind the guard
    // every logged-out page load would 401 and the seasonal skin would be
    // invisible to exactly the audience it exists for.
    expect(pub).toBeLessThan(guard);
  });

  it('mounts the admin pack router AFTER the guard', () => {
    const guard = appSource.indexOf("mountApi(app, '', authenticate)");
    const admin = appSource.indexOf("mountApi(app, '', brandingPackAdminRoutes)");
    expect(admin).toBeGreaterThan(guard);
  });

  it('the public router declares no /admin path', () => {
    // Read the SOURCE rather than importing the module: the routes file imports
    // the logger, which imports `config/env`, which calls process.exit(1) when the
    // test environment is not a full app environment. A structural read is the
    // same guarantee without booting the config.
    const src = read(path.join(__dirname, 'branding-pack.routes.ts'));
    const pubStart = src.indexOf('export const brandingPackPublicRoutes');
    const pubEnd = src.indexOf('export const brandingPackAdminRoutes');
    expect(pubStart).toBeGreaterThan(-1);
    expect(pubEnd).toBeGreaterThan(pubStart);
    const publicSection = src.slice(pubStart, pubEnd);
    const declared = publicSection.match(/brandingPackPublicRoutes\.(get|post|put|delete|patch)\(\s*'([^']+)'/g) ?? [];
    expect(declared.length).toBeGreaterThan(0);
    for (const decl of declared) {
      expect(decl).not.toContain('/admin');
    }
  });
});

describe('the one-active invariant is a DATABASE guarantee, not a convention', () => {
  const sql = read(MIGRATION);

  it('declares a partial unique index on status = active', () => {
    // Without this, two concurrent activations can both commit and the site is
    // left branded by a pack nobody selected last.
    expect(sql).toMatch(/CREATE UNIQUE INDEX[^;]*ON "branding_packs"\("status"\)[^;]*WHERE "status" = 'active'/);
  });

  it('is additive and states its rollback', () => {
    expect(sql).toContain('ADDITIVE ONLY');
    expect(sql).toMatch(/ROLLBACK:[\s\S]*DROP TABLE/);
    // A pack must never be able to orphan its assets.
    expect(sql).toMatch(/ON DELETE CASCADE/);
    expect(sql).toContain('BYTEA');
  });
});