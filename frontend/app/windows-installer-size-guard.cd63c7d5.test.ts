/**
 * cd63c7d5 — Windows installer size-guard pins (source-level).
 *
 * The mishap: Digby-Setup.exe is built by CI (windows.yml, NSIS) and then
 * committed BY HAND to frontend/public/ so digby.ai can serve it. GitHub
 * rejects any blob over 100 MiB AT PUSH TIME — the worst possible moment to
 * discover the payload grew. The fix: a fail-fast guard step in windows.yml
 * that stats the built exe and fails the build over a 95 MiB threshold
 * (100 MiB hard limit minus headroom).
 *
 * The Windows toolchain only exists on Windows runners, so — like the feed
 * pins in windows-feed-pins.test.ts — CI pins the CONTRACT at the source
 * level. These tests fail if someone edits windows.yml or digby.nsi in a way
 * that silently disconnects the guard from the exe it is supposed to measure:
 *
 *   • the guard step exists, sits between signing and artifact upload, and
 *     runs under the same condition (nsiScript != '') as the build/sign steps
 *   • the guard path is exactly workspace\publish\Digby-Setup.exe — the same
 *     folder the signing step signs and the default DIST_DIR digby.nsi
 *     writes to (OutFile "${DIST_DIR}\Digby-Setup.exe")
 *   • the guard threshold is 95 MiB and the error names the 100 MiB hard
 *     limit, so the failure is actionable (trim payload / tighten NSIS
 *     compression) instead of a mystery push rejection
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';

const WORKFLOW = readFileSync(
  fileURLToPath(new URL('../../.github/workflows/windows.yml', import.meta.url)),
  'utf8',
);
const NSIS = readFileSync(
  fileURLToPath(new URL('../../windows-shell/installer/digby.nsi', import.meta.url)),
  'utf8',
);

const guardStart = WORKFLOW.indexOf('- name: Guard installer size');
const signStart = WORKFLOW.indexOf('- name: Sign the installer');
const uploadStart = WORKFLOW.indexOf('- name: Upload build artifact');

describe('cd63c7d5 — windows.yml installer size guard', () => {
  it('has a guard step between signing and artifact upload', () => {
    expect(guardStart).toBeGreaterThan(-1);
    expect(signStart).toBeGreaterThan(-1);
    expect(uploadStart).toBeGreaterThan(-1);
    expect(guardStart).toBeGreaterThan(signStart);
    expect(guardStart).toBeLessThan(uploadStart);
  });

  it('runs under the same condition as the build/sign steps (nsiScript)', () => {
    const guardBlock = WORKFLOW.slice(guardStart, uploadStart);
    expect(guardBlock).toContain("if: steps.resolve.outputs.nsiScript != ''");
  });

  it('stats the exact exe the signing step signs and the feed points at', () => {
    const guardBlock = WORKFLOW.slice(guardStart, uploadStart);
    // The guard joins GITHUB_WORKSPACE + publish\Digby-Setup.exe
    expect(guardBlock).toContain('publish\\Digby-Setup.exe');
    // digby.nsi writes OutFile "${DIST_DIR}\Digby-Setup.exe" with default
    // DIST_DIR "..\..\publish" — same fixed filename, same folder
    expect(NSIS).toContain('OutFile "${DIST_DIR}\\Digby-Setup.exe"');
    expect(NSIS).toContain('!define DIST_DIR "..\\..\\publish"');
    // the signing step signs the same folder
    const signBlock = WORKFLOW.slice(signStart, guardStart);
    expect(signBlock).toContain('files-folder: ${{ github.workspace }}\\publish');
  });

  it('fails over 95 MiB with an actionable error naming the 100 MiB hard limit', () => {
    const guardBlock = WORKFLOW.slice(guardStart, uploadStart);
    expect(guardBlock).toContain('$limitBytes = 95 * 1024 * 1024');
    expect(guardBlock).toContain('100 MiB');
    // over-limit => Write-Error + exit 1 (fails the job), not just a warning
    expect(guardBlock).toMatch(/Write-Error[\s\S]*?exit 1/);
    // under-limit builds still pass: size -gt (strictly greater) comparison
    expect(guardBlock).toContain('$size -gt $limitBytes');
  });

  it('also fails when the exe is missing (build or DIST_DIR drift)', () => {
    const guardBlock = WORKFLOW.slice(guardStart, uploadStart);
    expect(guardBlock).toMatch(/Test-Path[\s\S]*?Write-Error[\s\S]*?exit 1/);
  });
});
