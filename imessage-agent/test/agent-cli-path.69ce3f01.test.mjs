/**
 * Ticket 69ce3f01 — "Runbook tells users to run `digby-agent` as a bare
 * command, but the installer never puts it on PATH — owner hit
 * `command not found`".
 *
 * THE MISHAP, REPLAYED: the owner typed a line straight out of
 * docs/UNATTENDED_DEVICES.md §10.4.2 on the Mac mini and got nothing:
 *
 *   paulcozzolino@Pauls-Mac-mini ~ % sudo digby-agent remote-access enable
 *   sudo: digby-agent: command not found
 *
 * That is not a user error. package.json declares
 * "bin": { "digby-agent": "dist/index.js" }, and a bin entry reaches PATH ONLY
 * through a global install or `npm link` — neither install shape does either.
 * install.sh copied the interpreter to
 * $HOME/Library/Application Support/Digby/bin/DigbyAgent and never wrote a
 * shim, so every `digby-agent …` line in the runbook was unrunnable on a stock
 * install. The owner read that as "this feature doesn't exist / my Mac is
 * broken" — on the feature whose whole point is avoiding owner round-trips.
 *
 * HOW THIS FILE TESTS IT: the shim is not compared as source text. The test
 * slices the REAL lines out of install.sh / postinstall and RUNS them under
 * bash against a fixture, then executes the file that lands on disk. That is
 * the only faithful reading now that the body uses $(...) expansion — and it
 * is what makes the review-N1 case (a home directory containing a `"` or `$`)
 * provable rather than assumed.
 *
 * WHAT IS PINNED (each assertion fails on the pre-fix tree):
 *   1. install.sh writes an executable shim into the STABLE runtime dir.
 *   2. The generated body execs DigbyAgent with the tree's dist/index.js and
 *      passes "$@" through — dispatch to remoteAccessCli/unattendedCli is
 *      argv[2], so passthrough is the feature.
 *   3. The generated body carries ABSOLUTE paths and never reads $HOME. This
 *      is the half the ticket's own suggested shim got wrong: the runbook runs
 *      `remote-access` under `sudo`, where $HOME is root's home.
 *   4. A path containing shell-hostile bytes still yields a WORKING shim
 *      (review N1 — otherwise the file is written broken and only fails the
 *      first time the owner runs it, i.e. this same ticket).
 *   5. install.sh's closing summary prints the shim path AND the PATH line.
 *   6. postinstall writes the same canonical shim, only AFTER the self-managed
 *      yield — a .pkg must never repoint `digby-agent` at the inert
 *      /Library/Digby payload (the stale-version class of 405927c9).
 *   7. No line in docs/UNATTENDED_DEVICES.md is an executable bare
 *      `digby-agent <sub>` command, and the doc still says where the command
 *      is, how to get it on PATH, and that sudo resets PATH.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const readPkg = (p) => readFileSync(join(pkgRoot, p), 'utf8');
const readRepo = (p) => readFileSync(join(pkgRoot, '..', p), 'utf8');

const installSh = readPkg('install.sh');
const postinstall = readRepo('macos-pkg/scripts/postinstall');
const docs = readRepo('docs/UNATTENDED_DEVICES.md');

/** Lines [from, to] of `src`, from the line starting `startAt` to the one equal to `endAt`. */
function slice(src, startAt, endAt) {
  const lines = src.split('\n');
  const from = lines.findIndex((l) => l.startsWith(startAt));
  assert.ok(from > -1, `expected a line starting ${JSON.stringify(startAt)}`);
  const to = lines.findIndex((l, i) => i > from && l.trim() === endAt);
  assert.ok(to > from, `expected a terminating ${JSON.stringify(endAt)} after ${startAt}`);
  return lines.slice(from, to + 1).join('\n');
}

function bash(script, env) {
  const r = spawnSync('bash', ['-c', script], { encoding: 'utf8', env: { ...process.env, ...env } });
  assert.equal(r.status, 0, `bash failed (${r.status}): ${r.stderr}`);
  return r;
}

/**
 * Run install.sh's REAL shim-writing lines against a fixture and hand back the
 * file that lands on disk. `digby_sq` lives outside the heredoc, so it is
 * sliced in too — otherwise this would test a body that install.sh never runs.
 */
function renderInstallShim(dir, { agentBin, agentDir }) {
  const script = [
    slice(installSh, 'digby_sq() {', '}'),
    slice(installSh, 'cat > "$DIGBY_CLI_SHIM"', 'DIGBY_CLI'),
    // The real chmod line — without it this would test a shim the installer
    // never produces (an unexecutable one).
    'chmod 755 "$DIGBY_CLI_SHIM"',
  ].join('\n');
  const shimPath = join(dir, 'bin', 'digby-agent');
  bash(script, { DIGBY_AGENT_BIN: agentBin, AGENT_DIR: agentDir, DIGBY_CLI_SHIM: shimPath });
  return { path: shimPath, body: readFileSync(shimPath, 'utf8') };
}

/** The same for the .pkg postinstall's shim block. */
function renderPkgShim(dir, { installDir }) {
  const script = slice(postinstall, 'cat > "$CLI_SHIM"', 'CLI');
  const shimPath = join(dir, 'bin', 'digby-agent');
  bash(script, {
    INSTALL_DIR: installDir,
    CLI_DIR: join(dir, 'bin'),
    CLI_SHIM: shimPath,
    USER_HOME: dir,
    CONSOLE_USER: 'nobody',
  });
  return { path: shimPath, body: readFileSync(shimPath, 'utf8') };
}

/** A stand-in DigbyAgent that prints the argv it was exec'd with, one per line. */
function fakeRuntime(dir) {
  const p = join(dir, 'DigbyAgent');
  writeFileSync(p, '#!/bin/sh\nprintf "%s\\n" "$@"\n');
  chmodSync(p, 0o755);
  return p;
}

/** Executable (non-comment, non-shebang) lines — what actually runs. */
const executableLines = (body) =>
  body.split('\n').filter((l) => l.trim() && !l.trim().startsWith('#'));

// ── 1. The shim exists, in the dir that survives a self-update ──────────────

test('69ce3f01: install.sh writes an executable digby-agent shim into the stable runtime dir', () => {
  // The runtime dir is the STABLE one: self-update swaps the agent TREE
  // wholesale, but $HOME/Library/Application Support/Digby/bin is not touched.
  assert.match(installSh, /DIGBY_RUNTIME_DIR="\$HOME\/Library\/Application Support\/Digby\/bin"/);
  assert.match(installSh, /DIGBY_CLI_SHIM="\$DIGBY_RUNTIME_DIR\/digby-agent"/);
  assert.match(installSh, /chmod 755 "\$DIGBY_CLI_SHIM"/);

  const dir = mkdtempSync(join(tmpdir(), 'digby-shim-69ce3f01-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const { path, body } = renderInstallShim(dir, {
      agentBin: fakeRuntime(dir),
      agentDir: join(dir, 'tree'),
    });
    assert.match(body, /^#!\/bin\/sh$/m, 'a /bin/sh shim runs without the user\'s shell config');
    // Any execute bit (owner/group/other) makes it runnable — `test -x` is a
    // shell builtin, so check the mode rather than spawning a binary.
    assert.ok((statSync(path).mode & 0o111) !== 0, 'the shim must be executable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. Run the generated file for real: argv passthrough ────────────────────

test('69ce3f01: the generated shim really passes the subcommand through', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digby-shim-69ce3f01-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const { path } = renderInstallShim(dir, {
      agentBin: fakeRuntime(dir),
      agentDir: join(dir, 'tree'),
    });

    const run = spawnSync(path, ['remote-access', 'enable', 'pcozz', 'utun4'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `shim exited ${run.status}: ${run.stderr}`);
    const argv = run.stdout.trim().split('\n');
    // argv[0] is the tree entry the runtime must run; the rest is the user's
    // command, intact and in order.
    assert.equal(argv[0], join(dir, 'tree', 'dist', 'index.js'));
    assert.deepEqual(argv.slice(1), ['remote-access', 'enable', 'pcozz', 'utun4']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 3. Absolute paths, not $HOME (the sudo half) ────────────────────────────

test('69ce3f01: the shim carries absolute paths, never a $HOME lookup', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digby-shim-69ce3f01-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const agentBin = fakeRuntime(dir);
    const { body } = renderInstallShim(dir, { agentBin, agentDir: join(dir, 'tree') });

    // Only EXECUTABLE lines matter: the shim's own comment explains the sudo
    // hazard by naming $HOME, and that comment is documentation, not a lookup.
    const code = executableLines(body).join('\n');
    // The ticket proposed `exec "$(dirname "$0")/DigbyAgent" "$HOME/Library/…"`.
    // Under sudo $HOME is root's home and the runbook's `remote-access` lines
    // are the ones that NEED sudo — a $HOME shim would exist and still fail.
    assert.ok(!/\$HOME/.test(code), 'shim must not read $HOME at run time (root\'s under sudo)');
    assert.ok(!/dirname "\$0"/.test(code), 'shim must not resolve the runtime relative to itself');
    // …and the generated file names the runtime ABSOLUTELY, which is only true
    // because the installer expanded it at write time.
    assert.ok(body.includes(agentBin), 'the runtime path must be written out in full');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 4. Review N1: shell-hostile paths still produce a WORKING shim ─────────

test('69ce3f01: a path with quotes/dollars still yields a working shim (review N1)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digby-shim-69ce3f01-'));
  try {
    // A home directory can legitimately contain these; the heredoc is
    // unquoted, so an unquoted interpolation would write a syntactically
    // broken shim — broken from the moment it lands, and (like the ticket)
    // only discovered when the owner runs it.
    const weird = join(dir, 'we"ird $dir');
    mkdirSync(join(weird, 'bin'), { recursive: true });
    mkdirSync(join(dir, 'bin'), { recursive: true });
    const agentBin = fakeRuntime(weird);

    const { path } = renderInstallShim(dir, { agentBin, agentDir: join(weird, 'tree') });
    const run = spawnSync(path, ['remote-access', 'status'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `shim with a quoted path failed: ${run.stderr}`);
    const argv = run.stdout.trim().split('\n');
    assert.equal(argv[0], join(weird, 'tree', 'dist', 'index.js'));
    assert.deepEqual(argv.slice(1), ['remote-access', 'status']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── 5. Say it out loud in the closing summary ───────────────────────────────

test('69ce3f01: install.sh prints the shim path and the PATH line', () => {
  // A path buried in a variable fixes nothing the user can see: the owner's
  // failure was not knowing the command existed. The summary must name it.
  assert.match(installSh, /The 'digby-agent' command is installed at:/);
  assert.match(installSh, /echo "    \$DIGBY_CLI_SHIM"/);
  // The exact PATH line, quoting-inside-quoting and all — it must be
  // paste-ready, and it must point at the same dir the shim lives in.
  assert.match(
    installSh,
    /echo 'export PATH=\\"\\\$HOME\/Library\/Application Support\/Digby\/bin:\\\$PATH\\"' >> ~\/\.zshrc && exec zsh/,
  );
});

// ── 6. The .pkg shape writes the same shim, and never shadows a live agent ──

test('69ce3f01: postinstall writes the canonical shim AFTER the self-managed yield', () => {
  const dir = mkdtempSync(join(tmpdir(), 'digby-shim-69ce3f01-'));
  try {
    mkdirSync(join(dir, 'bin'), { recursive: true });
    // The .pkg payload is inert on a Mac a one-line install owns, so this
    // points at a path that need not exist — the shim is only ever RUN when
    // the .pkg shape is the live one.
    const { body } = renderPkgShim(dir, { installDir: '/Library/Digby/imessage-agent' });
    assert.match(body, /^#!\/bin\/sh$/m);
    assert.ok(!/\$HOME/.test(executableLines(body).join('\n')), 'pkg shim must not read $HOME');
    assert.match(body, /"\$@"$/m, 'argv must pass through');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  assert.match(postinstall, /CLI_SHIM="\$CLI_DIR\/digby-agent"/);
  assert.match(postinstall, /chmod 755 "\$CLI_SHIM"/);
  // ORDERING IS THE SAFETY PROPERTY (405927c9): a self-managed one-line
  // install owns the Mac and self-updates; a .pkg-written shim pointing at
  // the inert /Library/Digby payload would resurrect the stale-version bug.
  const yieldAt = postinstall.indexOf('SELF_PLIST');
  const shimAt = postinstall.indexOf('CLI_SHIM=');
  assert.ok(yieldAt > -1 && shimAt > -1, 'both surfaces must exist');
  assert.ok(shimAt > yieldAt, 'the shim must be written after (and thus skipped by) the yield exit');
  // Never a recursive ownership sweep over the shared Digby support root —
  // that tree can hold a live self-managed agent this .pkg must not touch.
  assert.ok(
    !/chown -R [^\n]*Application Support\/Digby"/.test(postinstall),
    'no recursive chown over the shared Digby support root',
  );
});

// ── 7. The runbook: nothing in it can say "command not found" ───────────────

test('69ce3f01: no executable bare `digby-agent <subcommand>` line remains in the runbook', () => {
  // The mishap verbatim: a documented line beginning `sudo digby-agent …`.
  // On a stock install that is a "command not found" — the whole ticket.
  const offenders = docs
    .split('\n')
    .map((line, i) => ({ line, n: i + 1 }))
    .filter(({ line }) =>
      /^\s*(sudo\s+)?digby-agent\s+(unattended|remote-access|pair|status|run)\b/.test(line),
    )
    .map(({ line, n }) => `docs/UNATTENDED_DEVICES.md:${n}: ${line.trim()}`);

  assert.deepEqual(
    offenders,
    [],
    'these documented lines would print "command not found" on a stock install — ' +
      'use "$DIGBY_AGENT" (and for sudo lines, "$HOME/Library/Application Support/Digby/bin/digby-agent"):\n' +
      offenders.join('\n'),
  );
});

test('69ce3f01: the runbook still explains where the command is and how to get it on PATH', () => {
  // The doc-side half of the fix must survive a future edit: the reader needs
  // the shim's location, the PATH line, and the sudo caveat.
  assert.match(docs, /\$HOME\/Library\/Application Support\/Digby\/bin\/digby-agent/);
  assert.match(docs, /export PATH="\$HOME\/Library\/Application Support\/Digby\/bin:\$PATH"/);
  assert.match(docs, /command not found/);
  // sudo resets PATH — the subtle half that keeps biting after the PATH line.
  assert.ok(
    /resets `PATH`|resets PATH/.test(docs),
    'the doc must say sudo resets PATH, or the sudo lines read as bare-command-safe',
  );
  // Every executable block binds the variable before using it.
  assert.match(docs, /DIGBY_AGENT="\$HOME\/Library\/Application Support\/Digby\/bin\/digby-agent"/);
  // The retrofit path for Macs installed before this fix.
  assert.match(docs, /Already installed before ticket 69ce3f01|Already installed/);
});