/**
 * Dependency security pins — ticket 3be57df0 (2026-10-13).
 *
 * Locks the backend's file-upload (multer) and spreadsheet (exceljs)
 * dependencies to their advisory-clearing state, so a casual
 * "npm install <pkg>@latest" or a caret-range normalization cannot silently
 * drift them back into a vulnerable line:
 *
 * - multer < 2.3.0 — 8 advisories, 6 HIGH (DoS via crafted/oversized array
 *   index multipart field names, deeply nested field names, async fileFilter
 *   size-limit race): GHSA-535w-7cp7-47q4, GHSA-wc9g-mqfw-jrwm,
 *   GHSA-qvfw-j98x-7q72, GHSA-72gw-mp4g-v24j, GHSA-5528-5vmv-3xc2,
 *   GHSA-xf7r-hgr6-v32p, GHSA-v52c-386h-88mc, GHSA-3p4h-7m6x-2hcm.
 * - xlsx (SheetJS) — REMOVED, replaced by exceljs. The npm `xlsx` package is
 *   unmaintained (registry stops at 0.18.5) and carries two HIGH advisories
 *   OSV flags on EVERY version (GHSA-4r6h-8v6p-xvw6 prototype pollution when
 *   reading crafted files — our extractXlsxText parses user uploads — and
 *   GHSA-5pgg-2g8v-p4x9 ReDoS) with no fixed version on the registry. Do NOT
 *   re-add `xlsx` in any form (registry range OR the cdn.sheetjs.com tarball:
 *   the vendor-fixed builds are fine code-wise but OSV's range is
 *   `introduced: "0"` with no fixed event, so every scanner flags them HIGH
 *   forever). exceljs (MIT, maintained) is the supported path.
 */

import fs from 'fs';
import path from 'path';

interface PkgJson {
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
}

function readBackendManifest(): PkgJson {
  // package.json sits at backend/ — this test lives two levels below it.
  const manifestPath = path.join(__dirname, '..', '..', '..', 'package.json');
  return JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as PkgJson;
}

/** The version range string declared in backend/package.json. */
function declaredRange(dep: string): string | undefined {
  const pkg = readBackendManifest();
  return pkg.dependencies[dep] ?? pkg.devDependencies[dep];
}

describe('dependency security pins — multer + exceljs (ticket 3be57df0)', () => {
  it('multer is pinned to >= 2.5.0 (advisory floor: GHSA-q7qp-rjg7-q26m / CVE-2026-113872 — DoS via pending async fileFilter after request teardown, fixed in 2.5.0; supersedes the 2.4.0 floor)', () => {
    expect(declaredRange('multer')).toBe('^2.5.0');
  });

  it('@types/multer is bumped in lockstep (2.3.0)', () => {
    expect(declaredRange('@types/multer')).toBe('^2.3.0');
  });

  it('exceljs is declared (the xlsx replacement, MIT, zero advisories)', () => {
    expect(declaredRange('exceljs')).toBeDefined();
  });

  it('the unmaintained SheetJS `xlsx` package is NOT a dependency (any form — registry or CDN)', () => {
    const pkg = readBackendManifest();
    const all = { ...pkg.dependencies, ...pkg.devDependencies };
    expect(all['xlsx']).toBeUndefined();
    // The CDN tarball form cleared npm audit but OSV flags every version
    // (range `introduced: "0"`, no fixed event) — it must not come back.
    expect(Object.values(all).some((r) => String(r).includes('cdn.sheetjs.com'))).toBe(false);
  });

  it('the installed exceljs actually resolves and supports our read/write surface', () => {
    // Resolves through node_modules — catches a broken lockfile as well as a
    // version drift.
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('S');
    ws.addRow(['k', 'v']);
    ws.addRow(['a', 1]);
    expect(ws.getCell('B2').value).toBe(1);
    // workbookText's iteration surface (eachSheet/eachRow/row.values shape).
    let cells: string[] = [];
    wb.eachSheet((sheet: any) => {
      sheet.eachRow({ includeEmpty: false }, (row: any) => {
        const vals = row.values;
        if (Array.isArray(vals)) cells.push(vals.slice(1).join('\t'));
      });
    });
    expect(cells).toEqual(['k\tv', 'a\t1']);
  });

  it('the installed multer still exposes memoryStorage (our only usage surface)', () => {
    const multer = require('multer');
    expect(typeof multer.memoryStorage).toBe('function');
  });
});
