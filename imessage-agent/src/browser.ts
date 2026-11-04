/**
 * Local browser automation for the Digby Mac agent (v0.2.0+).
 *
 * Runs a Playwright Chromium browser on the user's own machine using a PERSISTENT
 * profile (~/.config/digby-agent/browser-profile), so once the user logs into a
 * site in this browser, the agent reuses that logged-in session on later tasks —
 * which is the whole point of the local driver vs. the cloud one.
 *
 * HEADLESS by default (v0.4.0 — the chat side panel streams a screenshot of every
 * step, so a Chromium window popping over the user's work is pure noise; since
 * v0.4.1 the backend captures that live-view frame after EVERY action as JPEG).
 *
 * What this browser IS: Digby's OWN persistent profile — signed in wherever the
 * user logged in through Digby (pop-out), NOT the user's everyday Chrome/Safari
 * profile. Two exceptions: (a) tasks that need the user's real browser session
 * run through the computer-use path (computer.ts) instead, which drives their
 * actual screen; (b) CDP-ATTACH mode (v0.5.0, ticket 4258335e) — when the owner
 * has BOTH switched attach on (config.json browserCdpAttach / env) AND the task
 * carries the per-task attach param, ensurePage connects to the owner's everyday
 * Chrome over the DevTools protocol and runs the task in a DEDICATED NEW TAB of
 * their real signed-in profile (see cdp-attach.ts for the gates + safety rails).
 * When the
 * user genuinely must act on the page (login / 2FA), the backend sends
 * `browser_pop_out` → popOut() relaunches the browser HEADED on the SAME persistent
 * profile and restores the current URL. Escalation is per-session: browser_close
 * leaves a popped-out window open for the user, and the next session returns to
 * headless. Env overrides: DIGBY_BROWSER_HEADED=1 restores the old always-headed
 * behavior; DIGBY_BROWSER_HEADLESS=1 forces headless and wins over everything
 * (pop_out refuses). Since v0.4.4 the browser launches WITH the Chromium
 * sandbox (ticket 88915954): Playwright defaults it off, which passes
 * --no-sandbox — Chrome's "unsupported command-line flag" warning in headed
 * pop-outs and a strong automation tell on anti-bot surfaces; the macOS
 * Seatbelt sandbox needs no setuid helper, so enabling it is safe here. The
 * backend's LocalBrowserDriver dispatches `browser_<action>`
 * commands here; each method returns a BrowserObservation-shaped object the backend
 * feeds back to the browser model.
 */

import { homedir } from 'os';
import { dirname, join } from 'path';
import { existsSync } from 'fs';
import { execFile } from 'child_process';
import type { Browser, BrowserContext, Locator, Page } from 'playwright';
import { loadConfig } from './config.js';
import {
  cdpAttachEnabled, cdpPort, probeCdpEndpoint, classifyElement,
  MIN_ATTACH_CHROME_MAJOR,
  ATTACH_REFUSAL_CREDENTIAL, ATTACH_REFUSAL_SUBMIT, ATTACH_REFUSAL_SUBMIT_KEY,
  type ElementAttrs,
} from './cdp-attach.js';

const PROFILE_DIR = join(homedir(), '.config', 'digby-agent', 'browser-profile');
const MAX_CONTENT_CHARS = 8000;
const NAV_TIMEOUT_MS = 30000;
/** Cap a browser command's wait for the first-run Chromium download, so the
 *  backend's 45s dispatch window gets a fast, honest "setting up" error instead
 *  of a silent timeout. The download keeps going in the background. */
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
  /** Which browser ACTUALLY drove this action (4258335e): 'attached' = a
   *  dedicated new tab of the owner's everyday Chrome (CDP attach);
   *  'digby-profile' = Digby's own persistent profile (the default, and the
   *  attach fallback). The backend's disclosure wording branches on this. */
  mode?: 'digby-profile' | 'attached';
}

let ctx: BrowserContext | null = null;
let page: Page | null = null;
/** CDP-attach session state (4258335e): the owner's Chrome connection and the
 *  tab(s) WE opened in it — close() must close only those and DISCONNECT,
 *  never ctx.close() the owner's live context nor quit their Chrome. */
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

/** Stamp an observation with the mode that ACTUALLY drove it (4258335e) — the
 *  backend's disclosure branches on this, never on what was requested. */
function stamp<T extends Observation>(o: T): T {
  if (sessionMode) o.mode = sessionMode;
  return o;
}

/** Headless is the default (v0.4.0). DIGBY_BROWSER_HEADED=1 restores the old
 *  always-headed behavior; explicit DIGBY_BROWSER_HEADLESS=1 wins over everything. */
function defaultHeadless(): boolean {
  if (envFlag('DIGBY_BROWSER_HEADLESS')) return true;
  if (envFlag('DIGBY_BROWSER_HEADED')) return false;
  return true;
}

async function closeContext(): Promise<void> {
  try {
    if (sessionMode === 'attached') {
      // CDP-attach (4258335e): close only the tab(s) WE opened, then DISCONNECT
      // (Browser.close() on a connectOverCDP connection disconnects — it never
      // terminates the owner's Chrome). NEVER ctx.close(): that context is the
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

/** Path to the Playwright CLI shipped inside the playwright package. Resolved via
 *  the package's main entry (exports-map safe), cli.js sits at the package root. */
function playwrightCliPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const main = require.resolve('playwright');
  return join(dirname(main), 'cli.js');
}

let chromiumInstall: Promise<void> | null = null;

/**
 * Ensure the Chromium binary Playwright launches is actually present. The npm
 * package ships in the app bundle, but the ~170MB browser is NOT bundled (keeps
 * the DMG small) — it is downloaded once on the Mac into the default Playwright
 * cache. Safe to call concurrently: one shared install; a failed install resets
 * so the next call retries.
 */
export function ensureChromium(): Promise<void> {
  if (chromiumInstall) return chromiumInstall;
  chromiumInstall = (async () => {
    const { chromium } = await import('playwright');
    if (existsSync(chromium.executablePath())) return;
    log('chromium not installed — downloading (one-time browser setup)…');
    await new Promise<void>((resolve, reject) => {
      execFile(
        process.execPath, // the bundled DigbyHelper node — no PATH dependence
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
  'Local browser is being set up on your Mac (one-time Chromium download) — please try again in a minute or two.';

async function ensurePage(opts: { attach?: boolean } = {}): Promise<Page> {
  if (ctx && page && !page.isClosed()) {
    if (!userWindowPending) return page;
    // The previous session left its popped-out window open for the user (login/
    // 2FA). A new session starts on the default mode — close the leftover window
    // (whatever they logged into is already persisted to the profile) and
    // relaunch below.
    await closeContext();
  }
  userWindowPending = false;
  // CDP-attach mode (4258335e): BOTH gates — the owner's master switch
  // (config.json browserCdpAttach / DIGBY_BROWSER_CDP_ATTACH) AND this
  // session's per-task attach param — plus a reachable owner Chrome on the
  // debugging port. Then connect and run in a DEDICATED NEW TAB of their real
  // signed-in profile. ANY failure falls through to Digby's own profile below
  // (the observation's mode field reports what actually drove).
  if (opts.attach && cdpAttachEnabled(loadConfig())) {
    const port = cdpPort(loadConfig());
    const probe = await probeCdpEndpoint(port);
    if (probe.ok && probe.webSocketDebuggerUrl) {
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
          log(`attach: connected Chrome is ${probe.browser} — older than the recommended floor (${MIN_ATTACH_CHROME_MAJOR}); continuing, but suggest a Chrome upgrade if actions misbehave`);
        }
        log(`attach: connected to the owner's Chrome (${probe.browser || 'unknown build'}) on 127.0.0.1:${port} — task runs in a dedicated NEW TAB of THEIR signed-in profile`);
        return page;
      } catch (e: any) {
        log(`attach: connectOverCDP failed (${e?.message || e}) — falling back to Digby's own profile`);
        // Disconnect the half-open CDP connection before falling back — a
        // leaked connection holds the owner's Chrome debug port session.
        try { await attachedBrowser?.close(); } catch { /* best-effort */ }
        sessionMode = null;
        attachedBrowser = null;
        ctx = null;
        page = null;
      }
    } else {
      log(
        `attach: requested but no Chrome answered on http://127.0.0.1:${port} (${probe.error || 'no response'}) — ` +
        `falling back to Digby's own profile. To enable attach mode the owner launches their everyday Chrome with --remote-debugging-port=${port}.`,
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
  // Gate on the browser binary. If the first-run download is still in flight,
  // wait up to the dispatch window; otherwise fail fast with an actionable
  // message (the install continues in the background and the retry succeeds).
  if (!(await chromiumReady())) {
    const DOWNLOADING = Symbol('downloading');
    const outcome = await Promise.race([
      ensureChromium()
        .then(() => chromiumReady())
        .catch((e: any) => {
          throw new Error(`Local browser setup failed on your Mac: ${e?.message || e}`);
        }),
      new Promise<symbol>((r) => setTimeout(() => r(DOWNLOADING), CHROMIUM_WAIT_CAP_MS)),
    ]);
    if (outcome !== true) throw new Error(SETUP_MSG);
  }
  // Lazy import so the agent still runs (list/send iMessage) on machines where
  // playwright isn't installed — only browser_* commands need it.
  const { chromium } = await import('playwright');
  // Headless default; a pop-out escalation (headed for login/2FA) wins for the
  // rest of the session it was requested in.
  const headless = poppedOut ? false : defaultHeadless();
  ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless,
    // Run WITH the Chromium sandbox (feedback 88915954): Playwright defaults it
    // OFF, which makes every launch pass --no-sandbox — Chrome then shows the
    // "unsupported command-line flag" warning in headed pop-outs, and the flag
    // is a strong automation tell on anti-bot surfaces. The macOS (Seatbelt)
    // sandbox needs no setuid helper, so enabling it is safe on a user's Mac.
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

/** Evaluate the rail-relevant DOM attributes of a locator's first match (null
 *  when it resolves to nothing — the action then fails on its own Playwright
 *  error). Shared by the CSS path and the visible-text fallback so the attach
 *  rails inspect the SAME element that is about to be clicked (C4 finding). */
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

/** Click a CSS selector; fall back to a visible-text locator if that fails. */
export async function click(selector: string, opts: { attach?: boolean } = {}): Promise<Observation> {
  if (!selector) return { ok: false, error: 'click requires a selector' };
  const p = await ensurePage(opts);
  // Attach-mode rail (4258335e): never submit forms in the owner's real Chrome.
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
    // Attach-mode rail (4258335e, C4 review finding): the visible-text fallback
    // resolves an element the CSS-path rail above never saw — inspect THIS
    // element before clicking, so a schema-advertised text selector like
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
  // Attach-mode rails (4258335e): never type into password/credential fields,
  // never press Enter to submit — the owner does those by hand in their Chrome.
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
 * Screenshot of the current page. PNG by default (the model's own `screenshot`
 * tool); the backend's live-view captures (v0.4.1+, one per action, purely for
 * the chat side panel) ask for JPEG at a modest quality so the per-step frame is
 * a fraction of the PNG's bytes. `mime` rides back so the UI renders either.
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
 * Headed escalation (v0.4.0): relaunch the browser HEADED on the SAME persistent
 * profile (cookies/sessions kept) and restore the current URL, so the user can
 * complete a login / 2FA by hand. Sent by the backend as `browser_pop_out` when
 * the model asks the user to intervene. Per-session, not sticky: browser_close
 * leaves the window open for the user, and the NEXT session starts headless again.
 */
export async function popOut(): Promise<Observation> {
  if (envFlag('DIGBY_BROWSER_HEADLESS')) {
    return { ok: false, error: 'DIGBY_BROWSER_HEADLESS=1 forces headless on this Mac — pop-out is disabled.' };
  }
  if (sessionMode === 'attached') {
    // CDP-attach (4258335e): the owner's everyday Chrome is already headed and
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
    // The window was popped out FOR THE USER (login/2FA) — leave it open so they
    // can finish what they were asked to do. The next session's first browser
    // command replaces it with a fresh headless launch; the persistent profile
    // keeps whatever they logged into.
    poppedOut = false; // escalation is per-session, never sticky
    userWindowPending = true; // consumed by the next ensurePage
    log('close: leaving the popped-out window open for the user');
    return { ok: true };
  }
  poppedOut = false;
  await closeContext();
  return { ok: true };
}
