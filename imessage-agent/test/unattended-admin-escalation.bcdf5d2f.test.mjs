/**
 * Ticket bcdf5d2f — "still very messy setup flow.. normal users wouldnt know to
 * run sudo prefix to command".
 *
 * THE DEFECT THIS FILE REPLAYS. Enabling the unattended preset required the
 * owner to satisfy TWO opposite, undocumented preconditions at once:
 *
 *   1. `applyMacPreset` gated on `sudo -n true`. `-n` means NEVER PROMPT, so on
 *      a stock Mac that check ALWAYS failed. To pass it the owner had to know to
 *      run `sudo -v` in that same terminal first — a step the product mentioned
 *      only in docs/UNATTENDED_DEVICES.md §10.4.1, and phrased as "run it in a
 *      terminal where sudo is already authorised". Someone who did not already
 *      know about `sudo -v` had no way to succeed, and no way to learn why.
 *
 *   2. They must NOT do the obvious thing and prefix the command with `sudo`,
 *      because under sudo `$USER` is `root` and the preset then configures
 *      auto-login for root — it looks applied and strands the machine at the
 *      login window (docs §10.4.1, first table row).
 *
 * "Run this, but not with sudo, and first run sudo somehow else" is not a setup
 * flow a normal user can follow. The fix: the agent asks for the administrator
 * rights ITSELF, once, through sudo's own password prompt in the terminal the
 * user is already in — the standard escalation every installer does.
 *
 * WHAT IS PINNED HERE (pure — no Mac, no real sudo, runs on Linux CI):
 *   1. The happy path: already-authorised sudo needs no prompt and no change.
 *   2. The reported failure: unauthorised sudo now PROMPTS instead of refusing.
 *   3. Fail-closed when it cannot prompt (no terminal / prompt cancelled /
 *      not an admin) — with an actionable sentence, not a sudo ritual.
 *   4. applyMacPreset still touches NOTHING when rights are refused.
 *   5. The escalation helper never receives, carries or logs a password.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');

const {
  ensureAdminRights,
  applyMacPreset,
  UnattendedRefusal,
} = await import(join(pkgRoot, 'dist', 'unattended.js'));

/**
 * A scripted runner. `sudo -n true` answers `authorised`; `runInteractive` is
 * present only when the test models a terminal, and records what it was asked
 * to run so we can prove it is the sudo prompt and nothing else.
 */
function fakeIo({ authorised = false, interactive = true, promptCode = 0, grantAfterPrompt = true } = {}) {
  const calls = [];
  const interactiveCalls = [];
  let prompted = false;
  const io = {
    calls,
    interactiveCalls,
    async run(cmd, args) {
      const line = [cmd, ...(args || [])].join(' ');
      calls.push(line);
      if (line === 'fdesetup status') return { stdout: 'FileVault is Off.', code: 0 };
      if (line === 'sudo -n true') {
        // Before the prompt: authorised only if the test says so. After a
        // successful prompt: authorised when the prompt granted rights.
        const ok = authorised || (prompted && grantAfterPrompt);
        return { stdout: '', code: ok ? 0 : 1 };
      }
      return { stdout: '', code: 0 };
    },
  };
  if (interactive) {
    io.runInteractive = async (cmd, args) => {
      interactiveCalls.push([cmd, ...(args || [])].join(' '));
      prompted = true;
      return { code: promptCode };
    };
  }
  return io;
}

// ── 1. Already authorised: silent, no prompt ─────────────────────────────────

test('bcdf5d2f: an already-authorised terminal is not asked again', async () => {
  const io = fakeIo({ authorised: true });
  const r = await ensureAdminRights(io);
  assert.equal(r.ok, true);
  assert.equal(r.message, '');
  // No prompt appeared — the previous behaviour for this (working) case is kept.
  assert.deepEqual(io.interactiveCalls, []);
});

// ── 2. THE REPORTED DEFECT: it must ASK, not refuse ──────────────────────────

test('bcdf5d2f: unauthorised sudo PROMPTS for the password instead of refusing', async () => {
  const io = fakeIo({ authorised: false, promptCode: 0, grantAfterPrompt: true });
  const r = await ensureAdminRights(io);
  // Pre-fix this returned ok:false telling the user to go find `sudo -v`.
  assert.equal(r.ok, true, 'the agent must obtain the rights itself, not send the user hunting');
  // It asked via the ONE mechanism a normal user recognises: sudo's own prompt.
  assert.deepEqual(io.interactiveCalls, ['sudo -v']);
});

test('bcdf5d2f: the refusal no longer tells the user to pre-authorise sudo', async () => {
  // The exact pre-fix sentence, which assumed knowledge the report says nobody
  // has. It must be gone from the escalation path in every branch.
  const src = SRC('src/unattended.ts');
  assert.doesNotMatch(
    src,
    /Run it in a terminal where sudo is already authorised/,
    'that sentence asked a normal user to already know about `sudo -v`',
  );
  // And the gate itself must not be a bare non-prompting check any more.
  assert.doesNotMatch(
    src,
    /const sudo = await io\.run\('sudo', \['-n', 'true'\]\);\s*\n\s*if \(sudo\.code !== 0\)/,
    'the bare `sudo -n` refusal is the defect this ticket reports',
  );
});

// ── 3. Fail closed, with something a human can act on ────────────────────────

test('bcdf5d2f: no terminal to prompt in → honest refusal naming the one action', async () => {
  const io = fakeIo({ authorised: false, interactive: false });
  const r = await ensureAdminRights(io);
  assert.equal(r.ok, false);
  // It must name the concrete thing to do, and must not imply a hidden ritual.
  assert.match(r.message, /Terminal/i);
  assert.match(r.message, /Nothing was changed/);
  assert.doesNotMatch(r.message, /already authorised/);
});

test('bcdf5d2f: a cancelled password prompt refuses and changes nothing', async () => {
  const io = fakeIo({ authorised: false, promptCode: 1, grantAfterPrompt: false });
  const r = await ensureAdminRights(io);
  assert.equal(r.ok, false);
  assert.match(r.message, /Nothing was changed/);
  // It says the prompt was the thing that failed — not that they lack rights.
  assert.match(r.message, /cancelled|refused/i);
});

test('bcdf5d2f: a prompt that grants nothing is not read as authorisation', async () => {
  // sudoers can accept `sudo -v` and still deny the real commands. Trusting the
  // prompt alone would then fail one write at a time, mid-apply.
  const io = fakeIo({ authorised: false, promptCode: 0, grantAfterPrompt: false });
  const r = await ensureAdminRights(io);
  assert.equal(r.ok, false);
  assert.match(r.message, /not an administrator|administrator rights could not be confirmed/i);
});

// ── 4. Nothing is touched on a refusal (the pre-existing safety property) ────

test('bcdf5d2f: applyMacPreset refuses with no sudo AND writes no kcpassword', async () => {
  const io = fakeIo({ authorised: false, interactive: false });
  await assert.rejects(
    () => applyMacPreset(io, { user: 'paul', password: 'pw' }),
    (e) => e instanceof UnattendedRefusal && e.blocker === 'no-admin',
  );
  assert.ok(
    !io.calls.some((c) => c.includes('kcpassword')),
    'a refusal must leave the machine byte-identical',
  );
});

test('bcdf5d2f: applyMacPreset SUCCEEDS when the prompt grants rights', async () => {
  // The whole point: the flow a normal user can actually complete now works.
  const io = fakeIo({ authorised: false, promptCode: 0, grantAfterPrompt: true });
  const r = await applyMacPreset(io, { user: 'paul', password: 'hunter2' });
  assert.ok(r.applied.length > 0, 'the preset applied after the one prompt');
  assert.deepEqual(io.interactiveCalls, ['sudo -v']);
});

// ── 5. The escalation never handles a secret ─────────────────────────────────

test('bcdf5d2f: the escalation helper takes no password and passes none', async () => {
  const src = SRC('src/unattended.ts');
  const start = src.indexOf('export async function ensureAdminRights');
  assert.ok(start > -1, 'the helper exists');
  const body = src.slice(start, start + 2200);
  // Its signature carries no secret…
  assert.doesNotMatch(body.split('{')[0], /password/i);
  // …and its only interactive command is the authorization prompt itself.
  assert.match(body, /runInteractive\('sudo', \['-v'\]\)/);
  assert.doesNotMatch(body, /stdin|process\.env\.\w*PASS/);
});