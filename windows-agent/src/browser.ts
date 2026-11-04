/**
 * Local browser automation for the Digby Windows agent (W1, 2026-09-25).
 *
 * Port of imessage-agent/src/browser.ts (v0.5.0 contract) — the method
 * surface, parameter names, and result JSON shapes are BYTE-COMPATIBLE so
 * the backend's LocalBrowserDriver marshalling works unchanged:
 *   browser_navigate / browser_get_content / browser_extract / browser_click /
 *   browser_type / browser_scroll / browser_screenshot / browser_pop_out /
 *   browser_close
 *
 * What this browser IS (same doctrine as the Mac): Digby's OWN persistent
 * profile — signed in wherever the user logged in through Digby (pop-out),
 * NOT the user's everyday Chrome/Edge. Tasks needing the user's real
 * browser session run through the computer-use path instead. CDP-attach
 * (driving the user's everyday Chrome/Edge in a dedicated tab) is W2 — the
 * `attach` param is accepted on the wire (contract parity) but always
 * falls back to Digby's own profile, and the observation's `mode` field
 * reports what actually drove.
 *
 * Profile: %LOCALAPPDATA%\Digby\browser-profile (DIGBY_BROWSER_PROFILE
 * overrides; falls back to ~/.config/digby-agent/browser-profile on
 * non-Windows so dev boxes work).
 *
 * Headless by default; DIGBY_BROWSER_HEADED=1 restores always-headed;
 * DIGBY_BROWSER_HEADLESS=1 wins over everything (pop_out refuses) — the
 * exact macOS precedence.
 *
 * Chromium sandbox: enabled (chromiumSandbox: true), the 88915954 fix
 * ported. Windows' Chromium sandbox uses restricted tokens + job objects —
 * no setuid helper needed (unlike Linux) and no extra privileges required
 * for a standard user process, so it is safe to leave on by default.
 */

import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { loadConfig } from './config.js';
import {
  cdpAttachEnabled, cdpPort, probeCdpEndpoint, isAttachBrowser, isEdgeBrowser, classifyElement,
  MIN_ATTACH_CHROME_MAJOR,
  ATTACH_REFUSAL_CREDENTIAL, ATTACH_REFUSAL_SUBMIT, ATTACH_REFUSAL_SUBMIT_KEY,
  type ElementAttrs,
} from './cdp-attach.js';

const MAX_CONTENT_CHARS = 8000;
const NAV_TIMEOUT_MS = 30000;
/** Cap a browser command's wait for the first-run Chromium download, so the
 *  backend's 45s dispatch window gets a fast, honest "setting up" error
 *  instead of a silent timeout. The download keeps going in the background. */
const CHROMIUM_WAIT_CAP_MS = 35000;
const CHROMIUM_INSTALL_TIMEOUT_MS = 10 * 60_000;

function log(msg: string): void {
  console.log(`[${new Date().toISOString()}] [browser] ${msg}`);
}

interface Observation {
  ok: boolean;
  url?: string;
  content?: string;
  links?: Array<{ text: string; href: string }>;
  screenshotBase64?: string;
  error?: string;
  truncated?: boolean;
  /** Which browser ACTUALLY drove this action: 'digby-profile' = Digby's own
   *  persistent profile (the only mode on Windows until W2's CDP attach). */
  mode?: 'digby-profile' | 'attached';
}

// ── Profile resolution (pure — unit-tested on Linux) ─────────────────────────

/** Resolve the persistent profile directory. Exported for tests. */
export function resolveProfileDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.DIGBY_BROWSER_PROFILE || '').trim();
  if (override) return override;
  if (process.platform === 'win32' || env.LOCALAPPDATA) {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'Digby', 'browser-profile');
  }
  // Non-Windows dev box fallback (mirrors the macOS agent's layout).
  return join(homedir(), '.config', 'digby-agent', 'browser-profile');
}

export function profileDir(): string {
  return resolveProfileDir();
}

let ctx: BrowserContext | null = null;
let page: Page | null = null;
/** CDP-attach session state (W2): the owner's browser connection and the
 *  tab(s) WE opened in it — close() must close only those and DISCONNECT,
 *  never ctx.close() the owner's live context nor quit their browser. */
let attachedBrowser: Browser | null = null;
const ourPages = new Set<Page>();
let sessionMode: Observation['mode'] | null = null;
/** True while the live context is a pop-out (headed escalation for login/2FA). */
let poppedOut = false;
/** Set when browser_close deliberately left a popped-out window open for the
 *  user — the next session's first command replaces it with a fresh default
 *  launch instead of silently reusing the headed window. */
let userWindowPending = false;

const envFlag = (name: string): boolean => /^(1|true|yes)$/i.test(process.env[name] || '');

/** Stamp an observation with the mode that ACTUALLY drove it. */
function stamp<T extends Observation>(o: T): T {
  if (sessionMode) o.mode = sessionMode;
  return o;
}

/** Headless default; DIGBY_BROWSER_HEADLESS=1 wins over everything,
 *  DIGBY_BROWSER_HEADED=1 restores always-headed (macOS precedence).
 *  Takes the env to read (defaults to process.env) so it is unit-testable. */
export function defaultHeadless(env: NodeJS.ProcessEnv = process.env): boolean {
  const flag = (v: string | undefined): boolean => /^(1|true|yes)$/i.test(v || '');
  if (flag(env.DIGBY_BROWSER_HEADLESS)) return true;
  if (flag(env.DIGBY_BROWSER_HEADED)) return false;
  return true;
}

async function closeContext(): Promise<void> {
  try {
    if (sessionMode === 'attached') {
      // CDP-attach (W2): close only the tab(s) WE opened, then DISCONNECT
      // (Browser.close() on a connectOverCDP connection disconnects — it never
      // terminates the owner's browser). NEVER ctx.close(): that context is the
      // owner's live profile.
      for (const p of [...ourPages]) {
        try { if (!p.isClosed()) await p.close(); } catch { /* best-effort */ }
      }
      try { await attachedBrowser?.close(); } catch { /* best-effort — CDP disconnect */ }
    } else if (ctx) {
      await ctx.close();
    }
  } catch {
    /* best-effort */
  } finally {
    ctx = null;
    page = null;
    attachedBrowser = null;
    ourPages.clear();
    sessionMode = null;
  }
}

// ── Lazy Chromium setup (the macOS first-command gate, ported) ───────────────

/** Locate the Playwright CLI (playwright-core layout compatible). Pure —
 *  unit-tested on Linux. */
export function playwrightCliPath(): string {
  const here = dirname(require.resolve('playwright/package.json'));
  return join(here, 'cli.js');
}

let chromiumInstall: Promise<void> | null = null;

/** Ensure the Playwright Chromium binary exists (one-time download, ~170MB,
 *  NOT bundled with the agent). Safe to call concurrently: one shared
 *  install; a failed install resets so the next call retries. */
export function ensureChromium(): Promise<void> {
  if (chromiumInstall) return chromiumInstall;
  chromiumInstall = (async () => {
    const { chromium } = await import('playwright');
    if (existsSync(chromium.executablePath())) return;
    log('chromium not installed — downloading (one-time browser setup)…');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath,
        [playwrightCliPath(), 'install', 'chromium'],
        { timeout: CHROMIUM_INSTALL_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
        (err, _stdout, stderr) => (err ? reject(new Error(`playwright install chromium failed: ${err.message}${stderr ? ` — ${stderr.slice(-400)}` : ''}`)) : resolve()),
      );
    });
    log('chromium installed');
  })().catch((e) => {
    chromiumInstall = null; // allow retry on the next browser command / restart
    throw e;
  });
  return chromiumInstall;
}

/** True when the Chromium binary is present (no download pending/needed). */
export async function chromiumReady(): Promise<boolean> {
  try {
    const { chromium } = await import('playwright');
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}

const SETUP_MSG =
  'Local browser is being set up on your PC (one-time Chromium download) — please try again in a minute or two.';

async function ensurePage(opts: { attach?: boolean } = {}): Promise<Page> {
  if (ctx && page && !page.isClosed()) {
    if (!userWindowPending) return page;
    // The previous session left its popped-out window open for the user
    // (login/2FA). A new session starts on the default mode — close the
    // leftover window (whatever they logged into is already persisted to
    // the profile) and relaunch below.
    await closeContext();
  }
  userWindowPending = false;
  // CDP-attach mode (W2): BOTH gates — the owner's master switch
  // (config.json browserCdpAttach / DIGBY_BROWSER_CDP_ATTACH) AND this
  // session's per-task attach param — plus a reachable attach-eligible
  // browser (Chrome OR Edge, the W2 dual-browser rule) on the debugging
  // port. Then connect and run in a DEDICATED NEW TAB of their real
  // signed-in profile. ANY failure falls through to Digby's own profile
  // below (the observation's mode field reports what actually drove).
  if (opts.attach && cdpAttachEnabled(loadConfig())) {
    const port = cdpPort(loadConfig());
    const probe = await probeCdpEndpoint(port);
    if (probe.ok && probe.webSocketDebuggerUrl && isAttachBrowser(probe.browser)) {
      try {
        const { chromium } = await import('playwright');
        attachedBrowser = await chromium.connectOverCDP(probe.webSocketDebuggerUrl);
        const ownerCtx = attachedBrowser.contexts()[0] ?? (await attachedBrowser.newContext());
        ctx = ownerCtx;
        sessionMode = 'attached';
        // ALWAYS a dedicated new tab of the owner's profile — never reuse or
        // steal focus of their existing tabs (ctx.pages()[0] is FORBIDDEN here).
        page = await ownerCtx.newPage();
        ourPages.add(page);
        page.setDefaultTimeout(NAV_TIMEOUT_MS);
        if (probe.chromeMajor && probe.chromeMajor < MIN_ATTACH_CHROME_MAJOR) {
          log(`attach: connected browser is ${probe.browser} — older than the recommended floor (${MIN_ATTACH_CHROME_MAJOR}); continuing, but suggest a browser upgrade if actions misbehave`);
        }
        log(`attach: connected to the owner's ${isEdgeBrowser(probe.browser) ? 'Edge' : 'Chrome'} (${probe.browser || 'unknown build'}) on 127.0.0.1:${port} — task runs in a dedicated NEW TAB of THEIR signed-in profile`);
        return page;
      } catch (e: any) {
        log(`attach: connectOverCDP failed (${e?.message || e}) — falling back to Digby's own profile`);
        // Disconnect the half-open CDP connection before falling back — a
        // leaked connection holds the owner's browser debug port session.
        try { await attachedBrowser?.close(); } catch { /* best-effort */ }
        sessionMode = null;
        attachedBrowser = null;
        ctx = null;
        page = null;
      }
    } else {
      const why = !probe.ok
        ? (probe.error || 'no response')
        : `unsupported browser "${probe.browser || 'unknown'}"`;
      log(
        `attach: requested but no attach-eligible browser answered on http://127.0.0.1:${port} (${why}) — ` +
          `falling back to Digby's own profile. To enable attach mode the owner launches their everyday Chrome or Edge with --remote-debugging-port=${port}.`,
      );
    }
  }
  // Reaching here means no live page. A previous ATTACHED session whose tab
  // died (the owner closed it) or whose new commands stopped carrying the
  // attach param must not leak the CDP connection — clean it up before the
  // persistent-profile launch below.
  if (sessionMode === 'attached' || attachedBrowser) {
    await closeContext();
  }

  // Gate on the browser binary. If the first-run download is still in
  // flight, wait up to the dispatch window; otherwise fail fast with an
  // actionable message (the install continues and the retry succeeds).
  if (!(await chromiumReady())) {
    const DOWNLOADING = Symbol('downloading');
    const outcome = await Promise.race([
      ensureChromium()
        .then(() => chromiumReady())
        .catch((e: any) => {
          throw new Error(`Local browser setup failed on your PC: ${e?.message || e}`);
        }),
      new Promise<symbol>((r) => setTimeout(() => r(DOWNLOADING), CHROMIUM_WAIT_CAP_MS)),
    ]);
    if (outcome !== true) throw new Error(SETUP_MSG);
  }
  // Lazy import so the agent still runs (computer_* commands) on machines
  // where the playwright package is broken — only browser_* needs it.
  const { chromium } = await import('playwright');
  // Headless default; a pop-out escalation (headed for login/2FA) wins for
  // the rest of the session it was requested in.
  const headless = poppedOut ? false : defaultHeadless();
  ctx = await chromium.launchPersistentContext(profileDir(), {
    headless,
    // Run WITH the Chromium sandbox (feedback 88915954, ported): Playwright
    // defaults it OFF (--no-sandbox — a strong automation tell on anti-bot
    // surfaces). The Windows sandbox (restricted tokens + job objects) needs
    // no setuid helper and no extra privileges for a standard user process.
    chromiumSandbox: true,
    viewport: { width: 1280, height: 900 },
  });
  sessionMode = 'digby-profile';
  page = ctx.pages()[0] || (await ctx.newPage());
  page.setDefaultTimeout(NAV_TIMEOUT_MS);
  return page;
}

function clip(s: string): { content: string; truncated: boolean } {
  if (s.length <= MAX_CONTENT_CHARS) return { content: s, truncated: false };
  return { content: s.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]', truncated: true };
}

async function getLinks(p: Page): Promise<Array<{ text: string; href: string }>> {
  try {
    const links = await p.$$eval('a[href]', (els) =>
      els
        .map((a) => ({ text: (a.textContent || '').trim().slice(0, 120), href: (a as HTMLAnchorElement).href }))
        .filter((l) => l.href && !l.href.startsWith('javascript:')),
    );
    return links.slice(0, 50);
  } catch {
    return [];
  }
}

// ── The browser_* action surface (byte-compatible with the macOS agent) ─────

export async function navigate(url: string, opts: { attach?: boolean } = {}): Promise<Observation> {
  if (!url) return { ok: false, error: 'navigate requires a url' };
  const p = await ensurePage(opts);
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
  return stamp({ ok: true, url: p.url() });
}

export async function getContent(format: 'text' | 'html' | 'snapshot' = 'text', opts: { attach?: boolean } = {}): Promise<Observation> {
  const p = await ensurePage(opts);
  if (format === 'html') {
    const html = await p.content();
    const { content, truncated } = clip(html);
    return stamp({ ok: true, url: p.url(), content, truncated });
  }
  const text = (await p.innerText('body').catch(() => '')) || '';
  const { content, truncated } = clip(text);
  if (format === 'snapshot') {
    return stamp({ ok: true, url: p.url(), content, truncated, links: await getLinks(p) });
  }
  return stamp({ ok: true, url: p.url(), content, truncated });
}

/** Evaluate the rail-relevant DOM attributes of a locator's first match (null
 *  when it resolves to nothing — the action then fails on its own Playwright
 *  error). Shared by the CSS path and the visible-text fallback so the attach
 *  rails inspect the SAME element that is about to be clicked (the C4 review
 *  finding, ported). */
async function inspectLocator(loc: Locator): Promise<ElementAttrs | null> {
  try {
    return await loc.first().evaluate((el) => ({
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute('type') || '').toLowerCase(),
      autocomplete: (el.getAttribute('autocomplete') || '').toLowerCase(),
      name: el.getAttribute('name') || '',
      id: el.id || '',
      placeholder: el.getAttribute('placeholder') || '',
      role: el.getAttribute('role') || '',
      text: (el.textContent || '').trim().slice(0, 80),
      insideForm: !!el.closest('form'),
    }));
  } catch {
    return null;
  }
}

/** Resolve a CSS selector to its rail-relevant DOM attributes. */
async function inspectElement(p: Page, selector: string): Promise<ElementAttrs | null> {
  return inspectLocator(p.locator(selector));
}

/** Click a CSS selector; fall back to a visible-text locator if that fails. */
export async function click(selector: string, opts: { attach?: boolean } = {}): Promise<Observation> {
  if (!selector) return { ok: false, error: 'click requires a selector' };
  const p = await ensurePage(opts);
  // Attach-mode rail (W2): never submit forms in the owner's real browser.
  if (sessionMode === 'attached') {
    const attrs = await inspectElement(p, selector);
    if (attrs && classifyElement(attrs) === 'submit') {
      log(`attach rail: refusing to click a form-submit control ("${selector.slice(0, 60)}")`);
      return stamp({ ok: false, url: p.url(), error: ATTACH_REFUSAL_SUBMIT });
    }
  }
  try {
    await p.click(selector, { timeout: 8000 });
  } catch {
    const fb = p.getByText(selector, { exact: false }).first();
    // Attach-mode rail (the C4 review finding, ported): the visible-text
    // fallback resolves an element the CSS-path rail above never saw — inspect
    // THIS element before clicking, so a schema-advertised text selector like
    // "Sign in" cannot bypass the form-submit refusal.
    if (sessionMode === 'attached') {
      const fbAttrs = await inspectLocator(fb);
      if (fbAttrs && classifyElement(fbAttrs) === 'submit') {
        log(`attach rail: refusing to click a form-submit control via the text fallback ("${selector.slice(0, 60)}")`);
        return stamp({ ok: false, url: p.url(), error: ATTACH_REFUSAL_SUBMIT });
      }
    }
    await fb.click({ timeout: 8000 });
  }
  await p.waitForLoadState('domcontentloaded').catch(() => {});
  return stamp({ ok: true, url: p.url() });
}

export async function type(selector: string, text: string, submit = false, opts: { attach?: boolean } = {}): Promise<Observation> {
  if (!selector) return { ok: false, error: 'type requires a selector' };
  const p = await ensurePage(opts);
  // Attach-mode rails (W2): never type into password/credential fields,
  // never press Enter to submit — the owner does those by hand.
  if (sessionMode === 'attached') {
    const attrs = await inspectElement(p, selector);
    if (attrs && classifyElement(attrs) === 'credential') {
      log(`attach rail: refusing to type into a credential field ("${selector.slice(0, 60)}")`);
      return stamp({ ok: false, url: p.url(), error: ATTACH_REFUSAL_CREDENTIAL });
    }
    if (submit) {
      log(`attach rail: refusing Enter-to-submit ("${selector.slice(0, 60)}")`);
      return stamp({ ok: false, url: p.url(), error: ATTACH_REFUSAL_SUBMIT_KEY });
    }
  }
  await p.fill(selector, text || '');
  if (submit) {
    await p.keyboard.press('Enter');
    await p.waitForLoadState('domcontentloaded').catch(() => {});
  }
  return stamp({ ok: true, url: p.url() });
}

export async function scroll(direction: 'up' | 'down' | 'top' | 'bottom' = 'down', amount?: number, opts: { attach?: boolean } = {}): Promise<Observation> {
  const p = await ensurePage(opts);
  const px = amount && amount > 0 ? amount : 800;
  await p.evaluate(
    ({ direction, px }) => {
      if (direction === 'top') window.scrollTo(0, 0);
      else if (direction === 'bottom') window.scrollTo(0, document.body.scrollHeight);
      else window.scrollBy(0, direction === 'up' ? -px : px);
    },
    { direction, px },
  );
  return stamp({ ok: true, url: p.url() });
}

/**
 * Screenshot of the current page. PNG by default (the model's own
 * `screenshot` tool); the backend's live-view captures ask for JPEG at a
 * modest quality so the per-step frame is a fraction of the PNG's bytes.
 * `mime` rides back so the UI renders either.
 */
export async function screenshot(opts: { format?: 'png' | 'jpeg'; quality?: number; attach?: boolean } = {}): Promise<Observation & { mime: string }> {
  const p = await ensurePage(opts);
  const jpeg = opts.format === 'jpeg';
  const quality = jpeg ? Math.min(95, Math.max(20, Math.round(opts.quality ?? 60))) : undefined;
  const buf = await p.screenshot(jpeg ? { type: 'jpeg', quality } : { type: 'png' });
  return stamp({ ok: true, url: p.url(), screenshotBase64: buf.toString('base64'), mime: jpeg ? 'image/jpeg' : 'image/png' });
}

export async function getUrl(opts: { attach?: boolean } = {}): Promise<Observation> {
  const p = await ensurePage(opts);
  return stamp({ ok: true, url: p.url() });
}

/**
 * Headed escalation: relaunch the browser HEADED on the SAME persistent
 * profile (cookies/sessions kept) and restore the current URL, so the user
 * can complete a login / 2FA by hand. Sent by the backend as
 * `browser_pop_out`. Per-session, not sticky: browser_close leaves the
 * window open for the user, and the NEXT session starts headless again.
 */
export async function popOut(): Promise<Observation> {
  if (envFlag('DIGBY_BROWSER_HEADLESS')) {
    return { ok: false, error: 'DIGBY_BROWSER_HEADLESS=1 forces headless on this PC — pop-out is disabled.' };
  }
  if (sessionMode === 'attached') {
    // CDP-attach (W2): the owner's everyday browser is already headed and
    // visible on their screen — there is nothing to pop out.
    if (page && !page.isClosed()) return stamp({ ok: true, url: page.url() });
    return { ok: false, error: 'no live attached tab to show' };
  }
  if (!ctx || !page || page.isClosed()) {
    return { ok: false, error: 'no live browser session to pop out' };
  }
  const restoreUrl = page.url();
  if (poppedOut || !defaultHeadless()) return { ok: true, url: restoreUrl }; // already headed
  log('pop_out: relaunching headed so the user can interact');
  await closeContext();
  poppedOut = true;
  try {
    const p = await ensurePage(); // poppedOut → launches headed on the same profile
    if (restoreUrl && restoreUrl !== 'about:blank') {
      await p.goto(restoreUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS }).catch(() => {});
    }
    return { ok: true, url: p.url() };
  } catch (e: any) {
    poppedOut = false;
    return { ok: false, error: `pop-out relaunch failed: ${e?.message || e}` };
  }
}

export async function close(): Promise<Observation> {
  if (poppedOut && ctx && page && !page.isClosed()) {
    // The window was popped out FOR THE USER (login/2FA) — leave it open so
    // they can finish what they were asked to do. The next session's first
    // browser command replaces it with a fresh headless launch; the
    // persistent profile keeps whatever they logged into.
    poppedOut = false; // escalation is per-session, never sticky
    userWindowPending = true; // consumed by the next ensurePage
    log('close: leaving the popped-out window open for the user');
    return { ok: true };
  }
  poppedOut = false;
  await closeContext();
  return { ok: true };
}

// ── Dispatch table (the shape commands.ts consumes) ─────────────────────────

/** Build the browser command handler map. Each entry is the backend's
 *  `browser_<action>` method name → (params) => Observation-shaped result.
 *  Params + result shapes mirror the macOS agent's execute() switch. */
export function browserHandlers(): Record<string, (params: Record<string, unknown>) => Promise<unknown>> {
  const attachOf = (p: Record<string, unknown>) => p?.attach === true ? { attach: true } : {};
  return {
    browser_navigate: async (p) => navigate(String(p?.url || ''), attachOf(p)),
    browser_get_content: async (p) => getContent((p?.format as 'text' | 'html' | 'snapshot') || 'text', attachOf(p)),
    browser_extract: async (p) => getContent('text', attachOf(p)),
    browser_click: async (p) => click(String(p?.selector || ''), attachOf(p)),
    browser_type: async (p) => type(String(p?.selector || ''), String(p?.text || ''), Boolean(p?.submit), attachOf(p)),
    browser_scroll: async (p) => scroll((p?.direction as 'up' | 'down' | 'top' | 'bottom') || 'down', Number(p?.amount) || undefined, attachOf(p)),
    browser_screenshot: async (p) =>
      screenshot({
        format: p?.format === 'jpeg' ? 'jpeg' : 'png',
        quality: Number(p?.quality) || undefined,
        ...attachOf(p),
      }),
    browser_pop_out: async () => popOut(),
    browser_close: async () => close(),
    browser_get_url: async (p) => getUrl(attachOf(p)),
  };
}
