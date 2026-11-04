/**
 * CDP-attach W2 tests (port of the macOS 4258335e suite + the dual-browser
 * change), verified on Linux CI — no Windows box and no Chrome/Edge needed.
 *
 * Two layers, mirroring the house idiom:
 *   1. REAL unit tests of the attach logic — cdp-attach.ts is deliberately
 *      Playwright-free (fetch + pure predicates), imported from dist/ after
 *      the build (npm test runs `tsc` first), so these exercise the actual
 *      code that ships.
 *   2. SOURCE-BYTES pins on the Playwright wiring in browser.ts (the parts
 *      that cannot run without a real browser): connectOverCDP on the PROBED
 *      ws URL, dedicated-new-tab (never ctx.pages()[0] in the attach branch),
 *      disconnect-not-quit close, the credential/submit rails (both the CSS
 *      path and the visible-text fallback), mode stamping, and the 0.8.0
 *      version bump.
 *
 * The W2 DUAL-BROWSER RULE: the probe result must be attach-eligible for BOTH
 * Chrome ("Chrome/131…") and Edge ("…Edg/131…") Browser headers — Edge is
 * guaranteed present on Windows and is ~10–14% of users' everyday browser
 * (roadmap §2.10), so when the owner's everyday browser is Edge and it runs
 * with --remote-debugging-port, attach drives THEIR Edge.
 *
 * Plain .mjs, zero TypeScript annotations, imports BUILT dist/*.js, no
 * "os" field in package.json — the W0/W1 rules.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = join(here, '..');
const srcRoot = join(pkgRoot, 'src');
const SRC = (rel) => readFileSync(join(pkgRoot, rel), 'utf8');
const browserSrc = SRC('src/browser.ts');
const configSrc = SRC('src/config.ts');
const cdpSrc = SRC('src/cdp-attach.ts');
const pkg = JSON.parse(SRC('package.json'));

// Negative source-bytes pins must not match the prose that documents the rule
// itself (the attach comments literally name the forbidden idioms) — strip
// line comments before asserting.
const stripLineComments = (s) => s.replace(/(^|\s)\/\/[^\n]*/g, '$1');

const {
  cdpAttachEnabled, cdpPort, probeCdpEndpoint, classifyElement,
  isAttachBrowser, isEdgeBrowser,
  DEFAULT_CDP_PORT, MIN_ATTACH_CHROME_MAJOR,
} = await import(join(pkgRoot, 'dist', 'cdp-attach.js'));

// ── 1. The two opt-in gates ──────────────────────────────────────────────────

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
  assert.equal(cdpPort(null), DEFAULT_CDP_PORT); // garbage env falls back
  delete process.env.DIGBY_BROWSER_CDP_PORT;
});

test('cdpPort: out-of-range / non-finite config values fall back to default', () => {
  delete process.env.DIGBY_BROWSER_CDP_PORT;
  assert.equal(cdpPort({ browserCdpPort: 0 }), DEFAULT_CDP_PORT);
  assert.equal(cdpPort({ browserCdpPort: -1 }), DEFAULT_CDP_PORT);
  assert.equal(cdpPort({ browserCdpPort: 70000 }), DEFAULT_CDP_PORT);
  assert.equal(cdpPort({ browserCdpPort: Number.NaN }), DEFAULT_CDP_PORT);
  assert.equal(cdpPort({ browserCdpPort: 123.9 }), 123); // fractional floors
});

// ── 2. The W2 dual-browser predicate ─────────────────────────────────────────

test('isAttachBrowser: Chrome headers are attach-eligible', () => {
  assert.equal(isAttachBrowser('Chrome/131.0.6778.86'), true);
  assert.equal(isAttachBrowser('Chrome/120.0.6099.130'), true);
  assert.equal(isAttachBrowser('HeadlessChrome/125.0.0.0'), true);
  assert.equal(isAttachBrowser('Chromium/130.0.0.0'), true);
});

test('isAttachBrowser: EDGE headers are attach-eligible (the W2 rule)', () => {
  // Edge's UA-style Browser header keeps the Chrome prefix and appends Edg/.
  assert.equal(isAttachBrowser('Chrome/131.0.6778.86 Edg/131.0.2903.86'), true);
  assert.equal(isAttachBrowser('Chrome/120.0.2210.91 Edg/120.0.2210.91'), true);
  assert.equal(isAttachBrowser('Edg/131.0.2903.86'), true);
  assert.equal(isAttachBrowser('Edge/131.0.2903.86'), true);
});

test('isAttachBrowser: non-Chromium endpoints are refused (fail fast, no wasted CDP attempt)', () => {
  // A node --inspector or other DevTools-ish endpoint that happens to be on
  // the port would answer /json/version with a ws URL but a non-Chromium
  // Browser header — refuse BEFORE the connectOverCDP attempt.
  assert.equal(isAttachBrowser('node.js/v22'), false);
  assert.equal(isAttachBrowser('Firefox/132.0'), false);
  assert.equal(isAttachBrowser('Safari/17.4'), false);
});

test('isAttachBrowser: a MISSING Browser header stays eligible', () => {
  // Same behavior as the macOS agent: an endpoint that answers /json/version
  // WITH a webSocketDebuggerUrl speaks the Chromium DevTools protocol by
  // definition. The probe already required the ws URL.
  assert.equal(isAttachBrowser(undefined), true);
  assert.equal(isAttachBrowser(''), true);
});

test('isEdgeBrowser: distinguishes Edge for the disclosure wording', () => {
  assert.equal(isEdgeBrowser('Chrome/131.0.6778.86 Edg/131.0.2903.86'), true);
  assert.equal(isEdgeBrowser('Edg/131.0.2903.86'), true);
  assert.equal(isEdgeBrowser('Chrome/131.0.6778.86'), false);
  assert.equal(isEdgeBrowser(undefined), false);
  assert.equal(isEdgeBrowser(''), false);
});

// ── 3. Probe matrix: ok shapes for Chrome AND Edge + error shapes ────────────

test('probeCdpEndpoint: parses a real Chrome /json/version payload', async () => {
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

test('probeCdpEndpoint: parses a real EDGE /json/version payload (the W2 rule)', async () => {
  const fetchImpl = async () => ({
    ok: true,
    json: async () => ({
      Browser: 'Chrome/131.0.6778.86 Edg/131.0.2903.86',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/edge-xyz',
    }),
  });
  const probe = await probeCdpEndpoint(9222, { fetchImpl });
  assert.equal(probe.ok, true);
  assert.equal(probe.browser, 'Chrome/131.0.6778.86 Edg/131.0.2903.86');
  // The Chromium-engine major (the FIRST number) — the shared engine version
  // for both Chrome and Edge headers.
  assert.equal(probe.chromeMajor, 131);
  assert.equal(probe.webSocketDebuggerUrl, 'ws://127.0.0.1:9222/devtools/browser/edge-xyz');
  // And the dual-browser predicate accepts it end-to-end.
  assert.equal(isAttachBrowser(probe.browser), true);
  assert.equal(isEdgeBrowser(probe.browser), true);
});

test('probeCdpEndpoint: never throws — no browser, HTTP error, and junk payloads all fail soft', async () => {
  const refused = await probeCdpEndpoint(9222, { fetchImpl: async () => { throw new Error('connect ECONNREFUSED'); } });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /ECONNREFUSED/);

  const httpErr = await probeCdpEndpoint(9222, { fetchImpl: async () => ({ ok: false, status: 403 }) });
  assert.equal(httpErr.ok, false);
  assert.match(httpErr.error, /HTTP 403/);

  const noWs = await probeCdpEndpoint(9222, { fetchImpl: async () => ({ ok: true, json: async () => ({ Browser: 'Chrome/131' }) }) });
  assert.equal(noWs.ok, false);
  assert.match(noWs.error, /no webSocketDebuggerUrl/);

  // Timeout → AbortError surfaces as a soft failure, not a hang.
  const slow = await probeCdpEndpoint(9222, {
    timeoutMs: 20,
    fetchImpl: (_url, init) => new Promise((_r, reject) => {
      init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }),
  });
  assert.equal(slow.ok, false);
  assert.match(slow.error, /no answer within 20ms/);
});

test('probeCdpEndpoint: probes EXACTLY /json/version on 127.0.0.1:<port> — no /json/list, single attempt', async () => {
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push(url);
    return {
      ok: true,
      json: async () => ({
        Browser: 'Chrome/131.0.6778.86',
        webSocketDebuggerUrl: 'ws://127.0.0.1:9555/devtools/browser/abc',
      }),
    };
  };
  await probeCdpEndpoint(9555, { fetchImpl });
  assert.deepEqual(seen, ['http://127.0.0.1:9555/json/version']);
});

// ── 4. Safety-rail classifier (the macOS contract, ported verbatim) ──────────

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
  assert.equal(classifyElement({ tag: 'input', type: 'text', name: 'search' }), null);
  assert.equal(classifyElement({ tag: 'input', type: 'text', name: 'email' }), null);
  assert.equal(classifyElement({ tag: 'button', type: 'button' }), null);
  assert.equal(classifyElement({ tag: 'button' }), null); // typeless, NOT in a form
  assert.equal(classifyElement({ tag: 'div', role: 'button', text: 'Next page' }), null);
  assert.equal(classifyElement({ tag: 'a', text: 'Read the docs' }), null);
});

test('classifyElement: the refusal constants name Chrome/Edge (the everyday browser)', async () => {
  const mod = await import(join(pkgRoot, 'dist', 'cdp-attach.js'));
  assert.match(mod.ATTACH_REFUSAL_CREDENTIAL, /everyday Chrome\/Edge/);
  assert.match(mod.ATTACH_REFUSAL_SUBMIT, /everyday Chrome\/Edge/);
  assert.match(mod.ATTACH_REFUSAL_SUBMIT_KEY, /everyday Chrome\/Edge/);
});

// ── 5. Attach-branch idiom pins (source-bytes on browser.ts) ─────────────────

test('attach branch: BOTH gates required — opts.attach && cdpAttachEnabled(loadConfig())', () => {
  assert.match(
    browserSrc,
    /if \(opts\.attach && cdpAttachEnabled\(loadConfig\(\)\)\) \{/,
    'ensurePage must gate on the per-task param AND the owner master switch',
  );
});

test('attach branch: connectOverCDP on the PROBED webSocketDebuggerUrl — never a hardcoded ws URL', () => {
  assert.match(
    browserSrc,
    /chromium\.connectOverCDP\(probe\.webSocketDebuggerUrl\)/,
    'must connect to the URL the /json/version probe returned',
  );
});

test('attach branch: DEDICATED new tab — ctx.pages()[0] is FORBIDDEN in the attach branch', () => {
  assert.match(browserSrc, /page = await ownerCtx\.newPage\(\);/);
  // Extract JUST the attach branch (from the attach gate to the persistent
  // launch) — ctx.pages()[0] IS legal in the default launch path below.
  const start = browserSrc.indexOf('if (opts.attach && cdpAttachEnabled');
  const end = browserSrc.indexOf('if (sessionMode === \'attached\' || attachedBrowser)');
  assert.ok(start > 0 && end > start, 'attach branch found in browser.ts');
  const attachBranch = browserSrc.slice(start, end);
  const noComments = stripLineComments(attachBranch);
  assert.doesNotMatch(
    noComments,
    /pages\(\)\[0\]/,
    'the attach branch must NEVER reuse ctx.pages()[0] — always a dedicated new tab',
  );
});

test('attach branch: falls back to Digby\'s own profile when the probe fails', () => {
  // The else-arm logs the fallback and execution continues to the
  // persistent-profile launch (no early return, no throw).
  const start = browserSrc.indexOf('if (opts.attach && cdpAttachEnabled');
  const end = browserSrc.indexOf('if (sessionMode === \'attached\' || attachedBrowser)');
  const attachBranch = browserSrc.slice(start, end);
  assert.match(attachBranch, /falling back to Digby's own profile/);
  assert.match(attachBranch, /--remote-debugging-port=\$\{port\}/); // actionable hint names the port
});

test('attach branch: the probe result gates on isAttachBrowser (Chrome AND Edge, the W2 rule)', () => {
  assert.match(
    browserSrc,
    /if \(probe\.ok && probe\.webSocketDebuggerUrl && isAttachBrowser\(probe\.browser\)\) \{/,
    'the connect arm must require the dual-browser predicate',
  );
});

test('attach branch: connect log discloses WHICH browser drove (isEdgeBrowser)', () => {
  assert.match(
    browserSrc,
    /isEdgeBrowser\(probe\.browser\) \? 'Edge' : 'Chrome'/,
  );
});

test('attach cleanup: a stale attached session is closed before the persistent launch', () => {
  assert.match(browserSrc, /if \(sessionMode === 'attached' \|\| attachedBrowser\) \{/);
  assert.match(browserSrc, /await closeContext\(\);/);
});

test('closeContext: attached sessions close only OUR tabs and DISCONNECT — never ctx.close() the owner profile', () => {
  const start = browserSrc.indexOf('async function closeContext');
  const end = browserSrc.indexOf('function playwrightCliPath');
  assert.ok(start > 0 && end > start, 'closeContext found');
  const body = stripLineComments(browserSrc.slice(start, end));
  assert.match(body, /if \(sessionMode === 'attached'\) \{/);
  assert.match(body, /attachedBrowser\?\.close\(\)/);
  // The owner's context must only be ctx.close()d in the NON-attached arm.
  const elseIdx = body.indexOf('} else if (ctx)');
  assert.ok(elseIdx > 0, 'the non-attached arm exists');
  const attachedArm = body.slice(body.indexOf('if (sessionMode ==='), elseIdx);
  assert.doesNotMatch(attachedArm, /ctx\.close\(\)/);
  assert.ok(
    body.indexOf('await ctx.close();', elseIdx) > elseIdx,
    'the NON-attached arm must ctx.close()',
  );
});

test('rails: click inspects the CSS-path element AND the visible-text fallback in attached mode', () => {
  assert.match(browserSrc, /const attrs = await inspectElement\(p, selector\);/);
  assert.match(browserSrc, /const fbAttrs = await inspectLocator\(fb\);/);
  assert.match(browserSrc, /classifyElement\(attrs\) === 'submit'/);
  assert.match(browserSrc, /classifyElement\(fbAttrs\) === 'submit'/);
});

test('rails: type refuses credential fields and Enter-to-submit in attached mode', () => {
  assert.match(browserSrc, /classifyElement\(attrs\) === 'credential'/);
  assert.match(browserSrc, /ATTACH_REFUSAL_SUBMIT_KEY/);
});

test('popOut: an attached session has nothing to pop out (already headed)', () => {
  assert.match(
    browserSrc,
    /no live attached tab to show/,
  );
});

// ── 6. Config switch + Playwright-free contract ──────────────────────────────

test('config: browserCdpAttach/browserCdpPort fields exist (the owner master switch)', () => {
  assert.match(configSrc, /browserCdpAttach\?: boolean;/);
  assert.match(configSrc, /browserCdpPort\?: number;/);
});

test('cdp-attach.ts is PLAYWRIGHT-FREE (the Linux CI contract)', () => {
  const noComments = stripLineComments(cdpSrc)
    .replace(/(^|\s)\/\*[\s\S]*?\*\//g, '$1'); // block comments too
  assert.doesNotMatch(noComments, /from 'playwright'|require\('playwright'\)/);
});

test('cdp-attach.ts exports the macOS-contract surface (plus the two W2 predicates)', async () => {
  const mod = await import(join(pkgRoot, 'dist', 'cdp-attach.js'));
  for (const name of [
    'cdpAttachEnabled', 'cdpPort', 'probeCdpEndpoint', 'classifyElement',
    'DEFAULT_CDP_PORT', 'MIN_ATTACH_CHROME_MAJOR',
    'ATTACH_REFUSAL_CREDENTIAL', 'ATTACH_REFUSAL_SUBMIT', 'ATTACH_REFUSAL_SUBMIT_KEY',
    'isAttachBrowser', 'isEdgeBrowser',
  ]) {
    assert.ok(mod[name] !== undefined, `cdp-attach must export ${name}`);
  }
  assert.equal(MIN_ATTACH_CHROME_MAJOR, 120); // warn-only floor, ported
});

// ── 7. Version + capabilities (0.8.0 rides the browser capability) ───────────

test('version: AGENT_VERSION 0.9.1, package.json tracks it, capabilities unchanged', async () => {
  const { AGENT_VERSION, PLATFORM, CAPABILITIES } = await import(join(pkgRoot, 'dist', 'advertisement.js'));
  assert.equal(AGENT_VERSION, '0.9.1');
  assert.equal(pkg.version, '0.9.1');
  assert.equal(PLATFORM, 'windows');
  assert.deepEqual([...CAPABILITIES], ['browser', 'computer']);
  // cdp-attach RIDES the browser capability — no 'cdp'/'attach' capability.
  assert.ok(!CAPABILITIES.includes('cdp'));
  assert.ok(!CAPABILITIES.includes('attach'));
  // uia_tree/uia_invoke RIDE the computer capability — no 'uia' capability.
  assert.ok(!CAPABILITIES.includes('uia'));
  // 0.9.0 > every backend gate (0.5.0 highest) AND > macOS 0.5.0, so the
  // backend's 0.9.0 minAgentVersion UIA gate keeps Macs from claiming UIA
  // commands while this agent claims everything.
  const [maj, min] = AGENT_VERSION.split('.').map(Number);
  assert.ok(maj > 0 || min >= 9, 'must clear the 0.9.0 UIA gate');
});
