/**
 * Ticket 36d1c99f — "when i run tyhe command to unattended enable it says
 * command not found … we want to cater to non technical uisers".
 *
 * THE OTHER HALF OF 69ce3f01. That ticket fixed the RUNBOOK (docs) so no
 * executable bare `digby-agent <sub>` line survives, and pinned it in
 * agent-cli-path.69ce3f01.test.mjs. But the agent's OWN RUNTIME OUTPUT kept
 * printing bare `digby-agent …` — and a refusal message is the single
 * most-copied line in the product: a user who just hit "you are not root"
 * pastes the remedy we printed straight into a terminal.
 *
 * On a stock install that paste fails:
 *
 *   $ sudo digby-agent remote-access enable paul
 *   sudo: digby-agent: command not found
 *
 * because `"bin": { "digby-agent": "dist/index.js" }` reaches PATH only via a
 * GLOBAL install or `npm link`, and neither install shape does either. Both
 * installers write the shim to
 * `~/Library/Application Support/Digby/bin/digby-agent` and nothing adds that
 * directory to `PATH`. So every bare name we print is a second failure layered
 * on the one the user was already reading about — on the feature whose whole
 * point is not needing a human.
 *
 * WHAT IS PINNED (each assertion fails on the pre-fix tree):
 *   1. `privilegedRunRefusal` prints the ABSOLUTE, quoted shim path — for the
 *      unprivileged refusal and for the unpaired one.
 *   2. The `sudo` remedy carries the path too (sudo resets PATH, so the bare
 *      form fails even AFTER the §4 PATH line).
 *   3. No user-facing remedy string in src/index.ts hands the user a bare
 *      `digby-agent <sub>` (the copy-paste-into-a-terminal surface).
 *
 * The doc half is deliberately NOT re-pinned here — 69ce3f01 owns it. This
 * file owns the RUNTIME half, which nothing covered.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const mod = await import('../dist/remote-access.js');
const { privilegedRunRefusal, MAC_AGENT_CLI_PATH, MAC_AGENT_CLI_QUOTED } = mod;

/**
 * The one string both installers actually write. Asserted as a literal here on
 * purpose: if the installer moves the shim, THIS test must fail rather than
 * silently keep passing against a path that no longer exists.
 */
const INSTALLED_SHIM = '$HOME/Library/Application Support/Digby/bin/digby-agent';

test('36d1c99f: the exported CLI path IS the path both installers write', () => {
  assert.equal(MAC_AGENT_CLI_PATH, INSTALLED_SHIM);
  assert.equal(MAC_AGENT_CLI_QUOTED, `"${INSTALLED_SHIM}"`);
});

test('36d1c99f: install.sh and postinstall still write that exact shim path', () => {
  // Belt-and-braces against the constant drifting away from the installers:
  // the AGENT constant is the authority for what we PRINT, the installers are
  // the authority for what EXISTS. They must agree.
  const installSh = SRC('install.sh');
  const postinstall = readFileSync(join(pkgRoot, '..', 'macos-pkg', 'scripts', 'postinstall'), 'utf8');
  assert.ok(
    installSh.includes('/Library/Application Support/Digby/bin'),
    'install.sh must still write the shim into the stable runtime dir',
  );
  assert.ok(
    postinstall.includes('/Library/Application Support/Digby/bin'),
    'postinstall must still write the same canonical shim',
  );
});

test('36d1c99f: the unprivileged refusal prints the ABSOLUTE path, not a bare name', () => {
  const msg = privilegedRunRefusal({ uid: 501, paired: true });
  assert.ok(msg, 'a non-root run must be refused');
  // The remedy the user will paste.
  assert.ok(msg.includes(INSTALLED_SHIM), 'the refusal must name the real shim path');
  assert.match(msg, /sudo "/, 'the sudo remedy must carry the quoted absolute path');
  // The pre-fix regression guard — the defect in the owner's own words.
  assert.doesNotMatch(
    msg,
    /sudo digby-agent /,
    'a bare `sudo digby-agent` is exactly the command that answers command-not-found',
  );
  // Pre-existing load-bearing halves must survive the change.
  assert.match(msg, /Administrator rights are required/);
  assert.match(msg, /Nothing was changed/);
});

test('36d1c99f: the unpaired refusal prints the ABSOLUTE path too', () => {
  const msg = privilegedRunRefusal({ uid: 0, paired: false });
  assert.ok(msg);
  assert.ok(msg.includes(INSTALLED_SHIM), 'the pairing remedy must name the real shim path');
  assert.doesNotMatch(msg, /`digby-agent pair/, 'a bare `digby-agent pair` cannot run on a stock install');
  // The sudo-home trap hint is still there (c468f922 pinned it; keep it pinned).
  assert.match(msg, /~\/\.config\/digby-agent/);
});

test('36d1c99f: no user-facing remedy string in index.ts prints a bare digby-agent subcommand', () => {
  const idx = SRC('src/index.ts');

  // Only the lines that hand a command to a human. Usage/help banners and
  // comments legitimately say `digby-agent <sub>` as the package's NAME; what
  // must never happen is printing it as a runnable REMEDY.
  const remedyLines = idx
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) => /Not paired|Re-run|restores every prior|removes all of it|remote-access: NOT ready/.test(line));

  assert.ok(remedyLines.length >= 4, `expected the remedy lines to still exist, found ${remedyLines.length}`);

  const offenders = remedyLines
    .filter(({ line }) => {
      // A correct line references the constant; a broken one hardcodes the name.
      if (line.includes('MAC_AGENT_CLI_QUOTED')) return false;
      return /(sudo )?digby-agent (pair|unattended|remote-access)\b/.test(line);
    })
    .map(({ line, n }) => `src/index.ts:${n}: ${line.trim()}`);

  assert.deepEqual(offenders, [], `these lines print a bare command the user cannot run:\n${offenders.join('\n')}`);
});