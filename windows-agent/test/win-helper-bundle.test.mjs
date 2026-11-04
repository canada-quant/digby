/**
 * Helper bundle-layout contract (ticket 4424ebd6, 2026-10-21).
 *
 * v0.9.0 shipped digby-win-helper.exe at the AGENT BUNDLE ROOT (digby.nsi
 * SecAgent: SetOutPath "$INSTDIR\agent" then File …\digby-win-helper.exe —
 * BESIDE the dist\ folder) while the agent probed only INSIDE dist\
 * (join(__dirname,'digby-win-helper.exe')). A fresh standard install paired
 * and polled fine but EVERY computer_* command failed with "helper
 * executable not found" — computer use fully unavailable on a device that
 * looked healthy in the device list (ticket 4424ebd6).
 *
 * The fix (0.9.1) probes the bundle root FIRST, then inside dist/. This
 * suite pins the CONTRACT BETWEEN THE TWO HALVES so neither can drift
 * alone: the installer's layout (windows-shell/installer/digby.nsi) and the
 * agent's probe order (dist/rust-helper.js helperProbePaths) must agree.
 * The C# toolchain only exists on Windows runners, so — like the shell
 * bootstrap pins (frontend/app/windows-shell-bootstrap-pins.test.ts) — this
 * pins the SOURCE files, on Linux, in the windows-agent suite CI already
 * runs (the workflow's agent-tests job).
 *
 * Run: `npm test` in windows-agent/ (builds dist/ first).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const NSI = join(pkgRoot, '..', 'windows-shell', 'installer', 'digby.nsi');

test('4424ebd6: the installer puts digby-win-helper.exe at the BUNDLE ROOT, beside dist/', () => {
  const nsi = readFileSync(NSI, 'utf8');

  // SecAgent's SetOutPath is the agent bundle root. (NSIS sections are
  // `Section "name" id` … `SectionEnd` — no braces.)
  const sec = nsi.match(/Section "Digby Agent[^"\n]*"[^\n]*\n([\s\S]*?)\nSectionEnd/);
  assert.ok(sec, 'digby.nsi must keep its "Digby Agent" section');
  const body = sec[1];
  assert.ok(body.includes('SetOutPath "$INSTDIR\\agent"'), 'SecAgent installs into $INSTDIR\\agent (the bundle root)');

  // …the helper File line lands the exe AT that root (a plain File, not
  // File /r of a folder containing it, and not a path into dist\)…
  const helperLine = body.match(/File[^\n]*digby-win-helper\.exe[^\n]*/);
  assert.ok(helperLine, 'SecAgent must File the helper exe');
  assert.ok(!/dist/.test(helperLine[0]), 'the helper File line must NOT install into dist\\ (4424ebd6: the exe belongs at the bundle root)');

  // …and the LAST SetOutPath BEFORE that File line is the bundle root —
  // NSIS File installs into the most recent SetOutPath, so a reordering
  // that lands the exe anywhere else must fail this pin (reviewer finding
  // on the first cut of this test: the contains-checks alone did not
  // catch a SetOutPath reordering mutation).
  const helperIdx = body.indexOf(helperLine[0]);
  const outsBefore = [...body.slice(0, helperIdx).matchAll(/SetOutPath ([^\r\n]+)/g)].map((m) => m[1].trim());
  assert.ok(outsBefore.length > 0, 'SecAgent must SetOutPath before File-ing the helper');
  assert.equal(
    outsBefore[outsBefore.length - 1],
    '"$INSTDIR\\agent"',
    'the LAST SetOutPath before the helper File line must be the bundle root',
  );

  // …and the agent bundle (dist\) is installed as a SUBFOLDER of that root
  // (File /r ${AGENT_PUBLISH_DIR}\dist) — so at runtime __dirname of the
  // agent entry is <bundle root>\dist, one level BELOW the exe.
  assert.ok(/File[^\n]*\/r[^\n]*\\dist/.test(body), 'SecAgent installs dist/ as a subfolder of the bundle root');
});

test('4424ebd6: the agent probes the bundle root FIRST (the shipped layout), inside dist/ second', async () => {
  const { helperProbePaths } = await import(join(pkgRoot, 'dist', 'rust-helper.js'));
  const probes = helperProbePaths(join('X:', 'agent', 'dist'));
  assert.deepEqual(probes, [
    join('X:', 'agent', 'digby-win-helper.exe'),   // bundle root — beside dist/ (the installer layout)
    join('X:', 'agent', 'dist', 'digby-win-helper.exe'), // inside dist/ — legacy manual workaround
  ]);
});

test('4424ebd6: AGENT_VERSION 0.9.1 — the helper-locator fix release, above every gate', async () => {
  const { AGENT_VERSION } = await import(join(pkgRoot, 'dist', 'advertisement.js'));
  assert.equal(AGENT_VERSION, '0.9.1');
  const [maj, min] = AGENT_VERSION.split('.').map(Number);
  assert.ok(maj > 0 || min >= 9, '0.9.1 must still clear the 0.9.0 UIA dispatch gate');
});
