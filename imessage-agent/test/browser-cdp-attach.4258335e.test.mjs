/**
 * CDP-attach mode tests (feedback ticket 4258335e — 88915954 ask c, 2026-09-22).
 *
 * Two layers, mirroring the house idiom:
 *   1. REAL unit tests of the attach logic — cdp-attach.ts is deliberately
 *      Playwright-free (fetch + pure predicates), imported from dist/ after the
 *      build (npm test runs `tsc` first), so these exercise the actual code.
 *   2. SOURCE-BYTES pins on the Playwright wiring in browser.ts (the parts that
 *      cannot run without a real Chrome): connectOverCDP, dedicated-new-tab
 *      (never ctx.pages()[0] in the attach branch), disconnect-not-quit close,
 *      the credential/submit rails, mode stamping, and the 0.5.0 version bump.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SRC = (rel) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const browserSrc = SRC('../src/browser.ts');
const configSrc = SRC('../src/config.ts');
const pkg = JSON.parse(SRC('../package.json'));

// Negative source-bytes pins must not match the prose that documents the rule
// itself (the attach comments literally name the forbidden idioms) — strip
// line comments before asserting.
const stripLineComments = (s) => s.replace(/(^|\s)\/\/[^\n]*/g, '$1');

const {
  cdpAttachEnabled, cdpPort, probeCdpEndpoint, classifyElement,
  DEFAULT_CDP_PORT,
} = await import('../dist/cdp-attach.js');

// ── 1. The two opt-in gates (ticket question 1) ──────────────────────────────

test('cdpAttachEnabled: OFF by default — no config flag, no env', () => {
  delete process.env.DIGBY_BROWSER_CDP_ATTACH;
  assert.equal(cdpAttachEnabled(null), false);
  assert.equal(cdpAttachEnabled({}), false);
  assert.equal(cdpAttachEnabled({ browserCdpAttach: false }), false);
});

test('cdpAttachEnabled: the owner master switch (config flag or env) turns it on', () => {
  delete process.env.DIGBY_BROWSER_CDP_ATTACH;
  assert.equal(cdpAttachEnabled({ browserCdpAttach: true }), true);
  process.env.DIGBY_BROWSER_CDP_ATTACH = '1';
  assert.equal(cdpAttachEnabled(null), true);
  delete process.env.DIGBY_BROWSER_CDP_ATTACH;
});

test('cdpPort: config > env > default 9222', () => {
  delete process.env.DIGBY_BROWSER_CDP_PORT;
  assert.equal(cdpPort(null), DEFAULT_CDP_PORT);
  assert.equal(DEFAULT_CDP_PORT, 9222);
  assert.equal(cdpPort({ browserCdpPort: 9333 }), 9333);
  process.env.DIGBY_BROWSER_CDP_PORT = '9444';
  assert.equal(cdpPort(null), 9444);
  assert.equal(cdpPort({ browserCdpPort: 9333 }), 9333); // config wins over env
  process.env.DIGBY_BROWSER_CDP_PORT = 'garbage';
  assert.equal(cdpPort(null), DEFAULT_CDP_PORT);
  delete process.env.DIGBY_BROWSER_CDP_PORT;
});

// ── 2. Probe + graceful fallback (ticket question 4) ─────────────────────────

test('probeCdpEndpoint: parses a real /json/version payload', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      Browser: 'Chrome/131.0.6778.86',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc',
    }),
  });
  const probe = await probeCdpEndpoint(9222, { fetchImpl });
  assert.equal(probe.ok, true);
  assert.equal(probe.browser, 'Chrome/131.0.6778.86');
  assert.equal(probe.chromeMajor, 131);
  assert.equal(probe.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/abc');
});

test('probeCdpEndpoint: never throws — no Chrome, HTTP error, and junk payloads all fail soft', async () => {
  const refused = await probeCdpEndpoint(9222, { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);

  const httpErr = await probeCdpEndpoint(9222, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(httpErr.ok, false);
  assert.match(httpErr.error, /HTTP 403/);

  const noWs = await probeCdpEndpoint(9222, { fetchImpl: async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/131' }) }) });
  assert.equal(noWs.ok, false);

  // Timeout → AbortError surfaces as a soft failure, not a hang.
  const slow = await probeCdpEndpoint(9222, {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(slow.ok, false);
});

// ── 3. Safety-rail classifier (ticket question 2) ────────────────────────────

test('classifyElement: credential fields are caught', () => {
  assert.equal(classifyElement({ tag: 'input', type: 'password' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', type: 'text', autocomplete: 'current-password' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', type: 'text', autocomplete: 'new-password' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', type: 'text', autocomplete: 'one-time-code' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', name: 'password' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', id: 'cvv' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', placeholder: 'Card number' }), 'credential');
  assert.equal(classifyElement({ tag: 'input', name: 'otp_code' }), 'credential');
});

test('classifyElement: submit controls are caught', () => {
  assert.equal(classifyElement({ tag: 'input', type: 'submit' }), 'submit');
  assert.equal(classifyElement({ tag: 'button', type: 'submit' }), 'submit');
  assert.equal(classifyElement({ tag: 'button', insideForm: true }), 'submit'); // HTML spec: typeless button in a form submits
  assert.equal(classifyElement({ tag: 'div', role: 'button', text: 'Sign in' }), 'submit');
  assert.equal(classifyElement({ tag: 'div', role: 'button', text: 'Place order' }), 'submit');
  assert.equal(classifyElement({ tag: 'div', role: 'button', text: 'Delete' }), 'submit');
});

test('classifyElement: ordinary controls pass (no over-refusal)', () => {
  assert.equal(classifyElement({ tag: 'input', type: 'text', name: 'q' }), null); // a search box
  assert.equal(classifyElement({ tag: 'input', type: 'search', placeholder: 'Search' }), null);
  assert.equal(classifyElement({ tag: 'button', type: 'button', insideForm: true }), null);
  assert.equal(classifyElement({ tag: 'button' }), null); // typeless button NOT in a form
  assert.equal(classifyElement({ tag: 'a', text: 'Sign in' }), null); // a link, not a button
  assert.equal(classifyElement({ tag: 'div', role: 'button', text: 'Show more' }), null);
  assert.equal(classifyElement({ tag: 'textarea', name: 'body' }), null);
});

// ── 4. Source-bytes pins on the Playwright wiring ────────────────────────────

test('4258335e: attach branch connects over CDP and ALWAYS opens a dedicated new tab', () => {
  assert.match(browserSrc, /chromium\.connectOverCDP\(probe\.webSocketDebuggerUrl\)/, 'attach must connect via connectOverCDP on the probed ws URL');
  assert.match(browserSrc, /page = await ownerCtx\.newPage\(\)/, 'attach must open a dedicated NEW TAB');
  // The attach branch must never reuse the owner's existing tabs: the
  // ctx.pages()[0] idiom is for the DIGBY profile launch only — it must not
  // appear inside the attach block.
  const attachBlock = stripLineComments(browserSrc.slice(browserSrc.indexOf('connectOverCDP')));
  const fallbackIdx = attachBlock.indexOf('launchPersistentContext');
  assert.ok(fallbackIdx > 0, 'expected the persistent-profile fallback after the attach block');
  assert.ok(!attachBlock.slice(0, fallbackIdx).includes('ctx.pages()[0]'), 'the attach branch must never touch ctx.pages()[0] (the owner\'s existing tabs)');
});

test('4258335e: close() in attached mode closes only our tab(s) and DISCONNECTS — never quits the owner\'s Chrome', () => {
  assert.match(browserSrc, /sessionMode === 'attached'/, 'closeContext must branch on the attached mode');
  const closeBlock = stripLineComments(browserSrc.slice(browserSrc.indexOf("sessionMode === 'attached'")));
  assert.match(closeBlock, /await attachedBrowser\?\.close\(\)/, 'attach close must disconnect via attachedBrowser.close()');
  // ctx.close() inside the attached branch would tear down the OWNER'S live
  // context — only the else-branch (Digby profile) may close a context.
  const attachedBranch = closeBlock.slice(0, closeBlock.indexOf('} else if (ctx)'));
  assert.ok(!attachedBranch.includes('ctx.close()'), 'the attached branch must NEVER ctx.close() the owner\'s context');
});

test('4258335e: the safety rails guard type() and click() in attached mode', () => {
  assert.match(browserSrc, /ATTACH_REFUSAL_CREDENTIAL/, 'type() must refuse credential fields in attached mode');
  assert.match(browserSrc, /ATTACH_REFUSAL_SUBMIT_KEY/, 'type() must refuse Enter-to-submit in attached mode');
  assert.match(browserSrc, /ATTACH_REFUSAL_SUBMIT/, 'click() must refuse form-submit controls in attached mode');
  // Rails only bite in attached mode — the Digby profile keeps full interaction.
  const railGuardCount = (browserSrc.match(/sessionMode === 'attached'/g) || []).length;
  assert.ok(railGuardCount >= 3, `expected ≥3 attached-mode guards (close + click + type + popOut), found ${railGuardCount}`);
});

test('4258335e (C4 pin): the visible-text click FALLBACK is rail-inspected before clicking in attached mode', () => {
  // C4 review finding (PR #978 adversarial review): click()'s getByText
  // fallback resolves an element the CSS-path rail never saw, so a
  // schema-advertised text selector like "Sign in" could submit a form in the
  // owner's real Chrome. The fallback element must be inspected — and refused
  // when it classifies as a submit control — BEFORE the click.
  const code = stripLineComments(browserSrc);
  const fbIdx = code.indexOf('getByText(selector');
  assert.ok(fbIdx > 0, 'expected the visible-text fallback in click()');
  const fbBranch = code.slice(fbIdx, fbIdx + 1200);
  const clickIdx = fbBranch.indexOf('fb.click(');
  assert.ok(clickIdx > 0, 'expected fb.click( in the fallback branch');
  const beforeClick = fbBranch.slice(0, clickIdx);
  assert.match(beforeClick, /inspectLocator\(fb\)/, 'the fallback element must be rail-inspected before clicking');
  assert.match(beforeClick, /classifyElement\(fbAttrs\) === 'submit'/, 'the fallback must classify the resolved element');
  assert.match(beforeClick, /ATTACH_REFUSAL_SUBMIT/, 'the fallback refusal must reuse the submit refusal');
  // The uninspected one-liner idiom that bypassed the rail must be gone.
  assert.ok(!code.includes('.first().click('), 'no uninspected .first().click( idiom may remain in browser.ts');
});

test('4258335e: every observation reports the ACTUAL mode (disclosure can never misname the driver)', () => {
  assert.match(browserSrc, /mode\?: 'digby-profile' \| 'attached'/, 'the Observation interface must carry the mode');
  assert.match(browserSrc, /function stamp</, 'a stamp() helper must mark observations with the actual session mode');
  assert.match(browserSrc, /sessionMode = 'digby-profile'/, 'the persistent-profile launch must record its mode');
  assert.match(browserSrc, /sessionMode = 'attached'/, 'the attach branch must record its mode');
});

test('4258335e: both gates are required — per-task param AND owner master switch', () => {
  assert.match(browserSrc, /opts\.attach && cdpAttachEnabled\(loadConfig\(\)\)/, 'attach requires BOTH the per-task param and the owner switch');
  assert.match(configSrc, /browserCdpAttach\?: boolean/, 'config carries the owner master switch (off by default)');
});

test('4258335e: agent version is 0.5.0 (backend gates attach dispatches on it)', () => {
  // 2f646c10 (2026-09-25): the version floor moved to 0.6.0 — the backend's
  // CDP-attach gate compares agentVersion ≥ 0.5.0, and every 0.6.0 agent
  // satisfies it, so the lockstep pin tracks the CURRENT version.
  assert.match(configSrc, /AGENT_VERSION = '0\.9\.24'/, 'config.ts AGENT_VERSION must be 0.9.24');
  assert.equal(pkg.version, '0.9.24', 'package.json version must match AGENT_VERSION');
});
