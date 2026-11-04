/**
 * Regression test for feedback ticket 88915954 (mishap, 2026-09-22) — the local
 * browser launched with Playwright's default --no-sandbox: Chrome shows the
 * "unsupported command-line flag --no-sandbox" warning (what the owner saw in
 * the pop-out window) and the flag is a strong automation tell on anti-bot
 * surfaces (DataDome challenge escalation measured on the canlegal-bench
 * CanLII harvest).
 *
 * Fix pinned here (ticket ask b): the local browser launches WITH the Chromium
 * sandbox enabled (chromiumSandbox: true — Playwright then stops passing
 * --no-sandbox) on the ONE dedicated persistent Digby profile
 * (~/.config/digby-agent/browser-profile) that is reused across sessions so
 * cookies/history accumulate and challenge rates drop.
 *
 * These are source-bytes pins: the launch options must keep the sandbox on and
 * must keep the single persistent profile dir. Run: `npm test` in
 * imessage-agent/ (builds dist/ first; this test reads src/, so it runs even
 * without playwright installed).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src/browser.ts', import.meta.url));
const src = readFileSync(SRC, 'utf8');

test('88915954: the local browser launches WITH the Chromium sandbox (never --no-sandbox)', () => {
  assert.match(src, /chromiumSandbox:\s*true/, 'launchPersistentContext must enable the Chromium sandbox');
  assert.ok(
    !src.includes("'--no-sandbox'") && !src.includes('"--no-sandbox"'),
    'browser.ts must never pass --no-sandbox (automation tell + Chrome warning banner)',
  );
});

test('88915954: ONE dedicated persistent profile is reused across sessions', () => {
  assert.match(
    src,
    /PROFILE_DIR\s*=\s*join\(homedir\(\),\s*'\.config',\s*'digby-agent',\s*'browser-profile'\)/,
    'the profile dir must stay the single persistent Digby profile',
  );
  assert.match(src, /launchPersistentContext\(PROFILE_DIR/, 'the launch must reuse that persistent profile');
});
