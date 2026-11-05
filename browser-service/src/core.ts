/**
 * Hosted hardened browser service — core (ticket ea3ad8a8).
 *
 * ONE pinned Chromium process; the isolation unit is the per-session browser
 * CONTEXT (own cookies / storage / cache — never a shared profile). Each
 * context's storage state is persisted to disk after every mutating action so
 * a recreated context resumes logged-in ("saved cache/VM-style" behavior).
 *
 * Auth: every request carries Authorization: Bearer <token> where
 * token = hmacSha256(BROWSER_SERVICE_SECRET, contextKey). The backend derives
 * the same token, so a token for one session never works for another, and the
 * secret itself is only ever an env var on the two services.
 *
 * Caps: max 1 live context per session key; max BROWSER_CONTEXTS_MAX total
 * (LRU-evicted); idle contexts reaped after BROWSER_CONTEXT_IDLE_MS.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as path from 'path';

export interface ServiceConfig {
  port: number;
  secret: string;
  dataDir: string;
  contextsMax: number;
  idleMs: number;
  /** Playwright module — injected so tests can pass a fake. */
  playwright: PlaywrightModule;
}

export interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean; args?: string[] }): Promise<PlaywrightBrowser>;
  };
}

export interface PlaywrightBrowser {
  newContext(opts?: Record<string, unknown>): Promise<PlaywrightContext>;
  close(): Promise<void>;
}

export interface PlaywrightContext {
  newPage(): Promise<PlaywrightPage>;
  storageState(opts?: { path?: string }): Promise<unknown>;
  close(): Promise<void>;
}

export interface PlaywrightPage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  content(): Promise<string>;
  title(): Promise<string>;
  url(): string;
  close(): Promise<void>;
  click(selector: string, opts?: { timeout?: number }): Promise<void>;
  fill(selector: string, text: string, opts?: { timeout?: number }): Promise<void>;
  press(selector: string, key: string, opts?: { timeout?: number }): Promise<void>;
  evaluate<T>(fn: string): Promise<T>;
  screenshot(opts?: Record<string, unknown>): Promise<Buffer>;
  setViewportSize(size: { width: number; height: number }): Promise<void>;
  /** Optional so a test fake need not implement it. Real Playwright always
   *  does — `settleAfterNavigate` uses it for the network-idle leg and falls
   *  back to the DOM-stability poll when it is absent or times out. */
  waitForLoadState?(state: string, opts?: { timeout?: number }): Promise<void>;
}

// ── Context manager ──────────────────────────────────────────────────────────

interface LiveContext {
  key: string;
  context: PlaywrightContext;
  page: PlaywrightPage | null;
  lastUsed: number;
}

export class BrowserContextManager {
  private browser: PlaywrightBrowser | null = null;
  private launching: Promise<PlaywrightBrowser> | null = null;
  private readonly live = new Map<string, LiveContext>();
  /** Per-key in-flight context creation (review M2): two simultaneous first
   *  requests for one key must share ONE context, not race two into existence
   *  (the loser would leak an invisible Chromium context outside the map). */
  private readonly creating = new Map<string, Promise<LiveContext>>();
  /** Keys with a create in flight (review R3): `live.size + creating.size`
   *  must respect contextsMax ACROSS the async create window — a pre-create
   *  check alone let N concurrent distinct keys all pass before any landed. */
  private reserved(key: string): number {
    let n = 0;
    for (const k of this.creating.keys()) if (k !== key) n++;
    return n;
  }
  private reaper: NodeJS.Timeout | null = null;

  constructor(private readonly cfg: ServiceConfig) {}

  /** Context key → on-disk storage-state path (hash so ids never become paths). */
  statePath(key: string): string {
    const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 32);
    return path.join(this.cfg.dataDir, `ctx-${h}.json`);
  }

  /** The per-session bearer token. Empty secret → '' — an empty HMAC key is a
   *  computable key (review R1: with secret='' an attacker forges any session's
   *  token), so NO token can ever match when unconfigured. verifyToken rejects
   *  '' before the constant-time compare. */
  tokenFor(key: string): string {
    if (!this.cfg.secret) return '';
    return crypto.createHmac('sha256', this.cfg.secret).update(`ctx:${key}`).digest('hex');
  }

  /** Verify a request's token against a context key (constant-time compare). */
  verifyToken(key: string, presented: string | undefined): boolean {
    if (!presented) return false;
    const expected = this.tokenFor(key);
    // Empty expected = unconfigured secret = INERT: reject everything (R1).
    if (!expected) return false;
    const a = Buffer.from(expected);
    const b = Buffer.from(presented);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  }

  private async ensureBrowser(): Promise<PlaywrightBrowser> {
    if (this.browser) return this.browser;
    if (this.launching) return this.launching;
    this.launching = this.cfg.playwright.chromium
      .launch({
        headless: true,
        // Hardened defaults: no first-run noise, no background throttling of
        // agent-driven pages, sandbox on (the container runs as non-root).
        args: [
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-background-timer-throttling',
          '--disable-backgrounding-occluded-windows',
          '--disable-dev-shm-usage',
        ],
      })
      .then((b) => {
        this.browser = b;
        return b;
      })
      .finally(() => { this.launching = null; });
    return this.launching;
  }

  /** Total-contexts cap: evict the least-recently-used context when full.
   *  `inFlight` = other keys with a create currently racing (review R3): the
   *  effective occupancy is live + in-flight, so the cap holds across the
   *  async create window, not just between awaits. */
  private evictIfFull(inFlight = 0): void {
    while (this.live.size + inFlight >= this.cfg.contextsMax) {
      let oldestKey: string | null = null;
      let oldest = Infinity;
      for (const [k, c] of this.live) {
        if (c.lastUsed < oldest) { oldest = c.lastUsed; oldestKey = k; }
      }
      if (!oldestKey) return;
      const victim = this.live.get(oldestKey)!;
      this.live.delete(oldestKey);
      void victim.context.close().catch(() => {});
    }
  }

  /** Ensure exactly ONE live context per session key (max-1 rule). Concurrent
   *  first-requests for the same key share one creation (review M2). A corrupt
   *  persisted state file is detected at newContext, DELETED, and retried
   *  fresh (review M1) — one bad JSON never bricks a session. */
  async ensureContext(key: string): Promise<LiveContext> {
    const existing = this.live.get(key);
    if (existing) {
      existing.lastUsed = Date.now();
      return existing;
    }
    const inFlight = this.creating.get(key);
    if (inFlight) return inFlight;

    // Reserve FIRST (review R3): the creating entry lands in the map BEFORE
    // the async body runs, so concurrent DISTINCT keys each count the others
    // — the cap holds across the async create window, not just between awaits.
    let settle!: (v: LiveContext) => void;
    let fail!: (e: unknown) => void;
    const created = new Promise<LiveContext>((res, rej) => { settle = res; fail = rej; });
    this.creating.set(key, created);

    void (async () => {
      try {
        const others = this.reserved(key); // other in-flight creates
        this.evictIfFull(others);
        if (this.live.size + others >= this.cfg.contextsMax) {
          // Nothing left to evict and live + in-flight already fills the cap:
          // reject rather than overshoot (the idle reaper + LRU free slots
          // continuously; the caller retries).
          throw new Error(
            `browser service at capacity (${this.cfg.contextsMax} contexts) — retry shortly`,
          );
        }
        const browser = await this.ensureBrowser();
        const stateFile = this.statePath(key);
        const opts: Record<string, unknown> = {
          viewport: { width: 1280, height: 900 },
          userAgent:
            'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
        };
        const hadState = fs.existsSync(stateFile);
        if (hadState) opts.storageState = stateFile;
        try {
          const context = await browser.newContext(opts);
          const live: LiveContext = { key, context, page: null, lastUsed: Date.now() };
          this.live.set(key, live);
          settle(live);
          return;
        } catch (e) {
          // Only a STATE-LOAD failure justifies destroying the persisted file
          // (review R2): a transient newContext error (browser overloaded, IPC
          // hiccup) must NOT delete a good login. Unlink only when the error
          // names the storage state, then retry once with the key omitted.
          const msg = e instanceof Error ? e.message : String(e);
          if (hadState && /storage state/i.test(msg)) {
            try { fs.unlinkSync(stateFile); } catch { /* best-effort */ }
            const { storageState: _bad, ...freshOpts } = opts as { storageState?: string };
            const context = await browser.newContext(freshOpts);
            const live: LiveContext = { key, context, page: null, lastUsed: Date.now() };
            this.live.set(key, live);
            settle(live);
            return;
          }
          throw e;
        }
      } catch (e) {
        fail(e);
      } finally {
        this.creating.delete(key);
      }
    })();

    return created;
  }

  async pageFor(key: string): Promise<PlaywrightPage> {
    const live = await this.ensureContext(key);
    if (!live.page) live.page = await live.context.newPage();
    return live.page;
  }

  /** Persist cookies + localStorage so the NEXT context resumes this session. */
  async persist(key: string): Promise<void> {
    const live = this.live.get(key);
    if (!live) return;
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      await live.context.storageState({ path: this.statePath(key) });
    } catch { /* best-effort: state persists from the last successful save */ }
  }

  async closeContext(key: string): Promise<void> {
    const live = this.live.get(key);
    if (!live) return;
    // Persist FIRST — persist() looks the context up in the live map, so the
    // entry must still exist when it runs. A failing save must not block
    // teardown (best-effort: state persists from the last successful save).
    try { await this.persist(key); } catch { /* best-effort */ }
    this.live.delete(key);
    try { await live.page?.close(); } catch { /* best-effort */ }
    try { await live.context.close(); } catch { /* best-effort */ }
  }

  /** Idle reaper: close contexts untouched for idleMs. */
  startReaper(): void {
    if (this.reaper) return;
    this.reaper = setInterval(() => {
      const now = Date.now();
      for (const [key, live] of [...this.live.entries()]) {
        if (now - live.lastUsed > this.cfg.idleMs) {
          void this.closeContext(key).catch(() => {});
        }
      }
    }, Math.min(this.cfg.idleMs, 60_000));
    this.reaper.unref?.();
  }

  async closeAll(): Promise<void> {
    if (this.reaper) { clearInterval(this.reaper); this.reaper = null; }
    for (const key of [...this.live.keys()]) {
      await this.closeContext(key).catch(() => {});
    }
    if (this.browser) {
      await this.browser.close().catch(() => {});
      this.browser = null;
    }
  }

  stats(): { contexts: number } {
    // Review M3: /health is UNAUTHENTICATED (it is the liveness probe) — it
    // reports the COUNT only. Session keys are ids; enumerating them to
    // anything on the network is a leak.
    return { contexts: this.live.size };
  }

  /** Is a secret configured? (BS-1 D3, 2026-11-02.) With no secret every token
   *  check fails by construction, so the service can serve NOTHING — yet it
   *  used to answer /health 200 and look perfectly healthy to a deploy wave.
   *  The server renders this as an unhealthy /health instead. */
  configured(): boolean {
    return !!this.cfg.secret;
  }
}

// ── Action execution (the driver-agnostic browser vocabulary) ────────────────

export interface ActionRequest {
  sessionId: string;
  action: {
    name: string;
    url?: string;
    format?: 'text' | 'html' | 'snapshot';
    selector?: string;
    text?: string;
    submit?: boolean;
    direction?: string;
    amount?: number;
    reasoning?: string;
  };
}

export interface ActionResponse {
  ok: boolean;
  action: string;
  url?: string;
  content?: string;
  screenshotBase64?: string;
  links?: Array<{ text: string; href: string }>;
  error?: string;
  truncated?: boolean;
  /** Machine-readable failure reason (BS-1 D1, 2026-11-02). Present iff
   *  `ok === false`; the HTTP status is derived from it, so a caller can
   *  branch on a stable code instead of pattern-matching prose. */
  errorCode?: ActionErrorCode;
  /** How navigate settled the page (BS-1 D2) — absent on non-navigate actions. */
  settle?: SettleResult;
}

/**
 * Machine-readable failure codes (BS-1 D1, 2026-11-02).
 *
 * Before this existed, `send(res, out.ok || out.error ? 200 : 200, out)` sent
 * BOTH branches to 200 — a failed navigate, a click that hit nothing and a
 * too-large screenshot all came back HTTP 200 with the failure buried in the
 * body, so every upstream branch on status code read a dead session as
 * healthy. These codes are the stable vocabulary the status map keys on.
 */
export type ActionErrorCode =
  | 'invalid_request'        // 400 — the action payload itself is unusable
  | 'unsupported_action'     // 400 — action name not in the vocabulary
  | 'selector_not_found'     // 422 — the element never appeared
  | 'navigation_failed'      // 502 — the URL could not be loaded at all
  | 'timeout'                // 504 — the page/action exceeded its budget
  | 'screenshot_too_large'   // 413 — the payload would blow the API budget
  | 'capacity'               // 503 — context cap reached, retry shortly
  | 'browser_error';         // 500 — anything else from the driver

/** Failure code → the HTTP status a caller (and a monitor) must see. */
export const STATUS_FOR_ERROR_CODE: Record<ActionErrorCode, number> = {
  invalid_request: 400,
  unsupported_action: 400,
  selector_not_found: 422,
  navigation_failed: 502,
  timeout: 504,
  screenshot_too_large: 413,
  capacity: 503,
  browser_error: 500,
};

/** The real status for one action outcome — the whole point of D1. */
export function statusForResponse(out: ActionResponse): number {
  if (out.ok) return 200;
  return STATUS_FOR_ERROR_CODE[out.errorCode ?? 'browser_error'] ?? 500;
}

/**
 * Map a driver error into the machine-readable vocabulary (BS-1 D1).
 * Playwright signals these classes in the MESSAGE, so classification is
 * message-shaped; anything unrecognised is `browser_error` (never a 200).
 */
export function classifyActionError(msg: string): ActionErrorCode {
  const m = String(msg ?? '');
  if (/at capacity|too many contexts/i.test(m)) return 'capacity';
  if (/timeout \d+ms exceeded|exceeded.*timeout|timed out/i.test(m)) {
    // A selector timeout means the element was never there; a page timeout is
    // the page's own budget. Both are honest failures, told apart for triage.
    return /waiting for (?:selector|locator)/i.test(m) ? 'selector_not_found' : 'timeout';
  }
  if (/no node found for selector|failed to find element|element (?:is )?not (?:visible|attached)|strict mode violation/i.test(m)) {
    return 'selector_not_found';
  }
  if (/net::ERR_|ERR_NAME_NOT_RESOLVED|ERR_CONNECTION_|ERR_SSL|ERR_CERT|navigating to|page\.goto/i.test(m)) {
    return 'navigation_failed';
  }
  return 'browser_error';
}

const MAX_CONTENT_CHARS = 8000;
const NAV_TIMEOUT_MS = 45_000;
const ACT_TIMEOUT_MS = 20_000;

// ── Render settle (BS-1 D2, 2026-11-02) ──────────────────────────────────────
/**
 * `navigate` used to resolve on `domcontentloaded`, which fires BEFORE a
 * client-side app has rendered: `get_content` then captured the empty shell and
 * reported success — exactly what the Facebook Ad Library returned.
 *
 * Navigating now settles the page before returning:
 *   1. `waitForLoadState('networkidle')` — the in-flight XHR/fetch that
 *      populates a JS app has finished; bounded and failure-tolerant.
 *   2. A DOM-stability poll — sample a cheap document signature until it stops
 *      changing (N consecutive equal samples). This is the documented fallback
 *      for pages whose network never goes idle (websocket, polling feed, ad
 *      SDK): `networkidle` alone times out on those and hands back the same
 *      shell we started with.
 *
 * Total budget is bounded (RENDER_SETTLE_MS) so a settle can never turn a
 * navigation into an unbounded wait. `BS_RENDER_SETTLE_DISABLED=1` restores the
 * pre-fix domcontentloaded-only behaviour wholesale.
 */
const RENDER_SETTLE_MS = Number(process.env.BS_RENDER_SETTLE_MS || 8_000);
const NETWORK_IDLE_TIMEOUT_MS = Number(process.env.BS_NETWORK_IDLE_TIMEOUT_MS || 6_000);
const SETTLE_POLL_INTERVAL_MS = 250;
const SETTLE_STABLE_SAMPLES = 2;
/** Kill switch (BS-1 D2): =1 restores domcontentloaded-only navigation. */
export const renderSettleDisabled = (): boolean => process.env.BS_RENDER_SETTLE_DISABLED === '1';

export interface SettleResult {
  /** Did any render evidence get observed (false = disabled, or no DOM at all)? */
  settled: boolean;
  /** How the settle concluded — surfaced on the navigate response for triage. */
  via: 'disabled' | 'networkidle' | 'dom-stable' | 'budget-exhausted';
  waitedMs: number;
}

/** Cheap, cheap-to-compare document signature: how much rendered text exists. */
const DOM_SIGNATURE_EXPR =
  `(() => { const b = document.body; if (!b) return '0';`
  + ` const t = b.innerText || ''; return String(t.length) + ':' + String(b.children.length); })()`;

// ── Settle after INTERACTION (BS-1 D2b, 2026-11-03) ──────────────────────────
/**
 * Resolving `navigate` on domcontentloaded was only HALF the D2 defect. A
 * `click` that triggers a client-side route change navigates the page exactly
 * like `goto` does — but nothing settled it, so the very next `get_content`
 * captured the same empty shell, this time while reporting `ok:true`.
 *
 * Measured in production 2026-11-03 (box A, session `ab-click-…`), the same
 * destination reached two ways:
 *
 *   navigate → https://quotes.toscrape.com/js/page/2/   read 3341 chars, 7 quotes
 *   navigate → …/js/ then click `li.next a`             read   45 chars, 0 quotes
 *   (…the same session re-read 2.5 s later)             read 3341 chars, 7 quotes
 *
 * so the content was always there — the read simply landed first. This is the
 * owner's Facebook Ad Library symptom surviving through the interaction door.
 *
 * `click` / `type` / `type+submit` therefore settle AFTER acting. Two guards
 * keep that honest and cheap:
 *
 *   1. PRE-CHECK — the settle budget is only spent when the page actually
 *      navigated. We record the URL before acting and settle only if it changed
 *      (or content went empty → something clearly replaced the document). A
 *      click that merely toggles state must not cost every caller 8 seconds.
 *   2. POST-POLL — after an observed navigation we give the new document a
 *      bounded window to appear before settling, because at click-return the
 *      document is often still empty. A url-only check would fire the settle
 *      against that empty document, leg 2 would bail on three empty signatures
 *      and we would be back to the shell.
 *
 * Detecting navigation with `page.url()` keeps the `PlaywrightPage` surface
 * unchanged, so a test fake needs no new method.
 */
export interface InteractionSettle {
  /** Did the page navigate as a result of the interaction? */
  navigated: boolean;
  /** The settle outcome when it navigated; absent when it did not. */
  settle?: SettleResult;
  /** Why it was skipped, for triage. */
  skipped?: 'disabled' | 'no-navigation';
}

/** Kill switch (BS-1 D2b): =1 restores interaction-without-settle (pre-fix). */
export const interactionSettleDisabled = (): boolean =>
  renderSettleDisabled() || process.env.BS_INTERACTION_SETTLE_DISABLED === '1';

/** Bound on waiting for a click-driven document to REPLACE the old one. Kept
 *  well under RENDER_SETTLE_MS so the two legs together stay inside budget. */
const NAV_SETTLE_WAIT_MS = Number(process.env.BS_INTERACTION_SETTLE_WAIT_MS || 3_000);
const INTERACTION_POLL_MS = 150;

/** Read the page URL without letting a hostile page throw. '' when unreadable. */
function safeUrl(page: PlaywrightPage): string {
  try { return page.url() || ''; } catch { return ''; }
}

/** Cheap "is there any rendered text?" probe. '' / '0:…' means empty document. */
async function domSignature(page: PlaywrightPage): Promise<string> {
  try {
    const raw = await page.evaluate<string>(DOM_SIGNATURE_EXPR);
    return raw == null ? '' : String(raw);
  } catch {
    return ''; // refused (cross-origin frame / torn-down page)
  }
}

/** Signature of a document with no rendered text — leg 2 bails on these. */
const isEmptySig = (sig: string): boolean => !sig || sig === '0' || sig === '0:0';

/**
 * Settle the page after an interaction that may have navigated it.
 * Never throws: a settle failure must not turn a successful click into an error.
 */
export async function settleAfterInteraction(
  page: PlaywrightPage,
  opts: { act: () => Promise<void>; urlBefore?: string; settleOnEmpty?: boolean },
): Promise<InteractionSettle> {
  const disabled = interactionSettleDisabled();
  const urlBefore = opts.urlBefore ?? safeUrl(page);

  await opts.act();
  if (disabled) return { navigated: false, skipped: 'disabled' };

  const urlAfter = safeUrl(page);
  const navigated = urlAfter !== urlBefore;

  // PRE-CHECK: a same-URL interaction (a toggle, a tab, a modal) must not pay
  // the settle budget. `settleOnEmpty` covers a document swap that keeps the
  // URL (in-page routing) and a same-URL reload.
  if (!navigated && !opts.settleOnEmpty) return { navigated: false, skipped: 'no-navigation' };

  // POST-POLL: at click-return the new document is frequently still empty.
  // Wait for it to appear (bounded) before handing over to the settle legs.
  const deadline = Date.now() + NAV_SETTLE_WAIT_MS;
  while (Date.now() < deadline && isEmptySig(await domSignature(page))) {
    await new Promise((r) => setTimeout(r, INTERACTION_POLL_MS));
  }

  return { navigated: true, settle: await settleAfterNavigate(page) };
}

/** Settle a freshly navigated page. Never throws — a settle failure must not
 *  turn a successful navigation into a failed one. */
export async function settleAfterNavigate(page: PlaywrightPage): Promise<SettleResult> {
  if (renderSettleDisabled()) return { settled: false, via: 'disabled', waitedMs: 0 };
  const started = Date.now();
  const deadline = started + RENDER_SETTLE_MS;

  // Leg 1 — network idle. Absent on a fake/older page object → skip to leg 2.
  let networkIdle = false;
  if (typeof page.waitForLoadState === 'function') {
    try {
      await page.waitForLoadState('networkidle', {
        timeout: Math.max(1, Math.min(NETWORK_IDLE_TIMEOUT_MS, deadline - Date.now())),
      });
      networkIdle = true;
    } catch { /* the page never idles (websocket/poller) — leg 2 decides */ }
  }

  // Leg 2 — DOM stability. Runs even after a successful networkidle, because an
  // idle network is not the same as a rendered frame (the app may still be on
  // its first layout). Stops as soon as the signature repeats.
  let last = '';
  let stable = 0;
  let sawDom = false;
  let empty = 0;
  while (Date.now() < deadline) {
    let sig = '';
    try {
      const raw = await page.evaluate<string>(DOM_SIGNATURE_EXPR);
      // Keep the raw value: String(null) is the TRUTHY "null", which would be
      // mistaken for real DOM evidence. Only a genuine signature counts.
      sig = raw == null ? '' : String(raw);
    } catch {
      sig = ''; // evaluation refused (cross-origin frame / torn-down page)
    }
    if (!sig || sig === '0' || sig === '0:0') {
      // No body / no rendered DOM yet. Three consecutive empties means there is
      // nothing to settle (about:blank, a PDF frame, a torn-down page) — bail
      // instead of burning the whole budget waiting for a DOM that is not
      // coming. `settled:false` tells the caller to treat content as unproven.
      empty += 1;
      if (empty >= 3) return { settled: false, via: 'dom-stable', waitedMs: Date.now() - started };
      await new Promise((r) => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
      continue;
    }
    empty = 0;
    sawDom = true;
    if (sig === last) {
      stable += 1;
      if (stable >= SETTLE_STABLE_SAMPLES - 1) {
        return { settled: sawDom, via: networkIdle ? 'networkidle' : 'dom-stable', waitedMs: Date.now() - started };
      }
    } else {
      stable = 0;
      last = sig;
    }
    await new Promise((r) => setTimeout(r, SETTLE_POLL_INTERVAL_MS));
  }
  return {
    settled: sawDom,
    via: networkIdle ? 'networkidle' : 'budget-exhausted',
    waitedMs: Date.now() - started,
  };
}

function clip(s: string): { content: string; truncated: boolean } {
  if (s.length <= MAX_CONTENT_CHARS) return { content: s, truncated: false };
  return { content: s.slice(0, MAX_CONTENT_CHARS) + '\n…[truncated]', truncated: true };
}

/** Extract links from rendered HTML (kept compact for the model). */
export function extractLinks(html: string): Array<{ text: string; href: string }> {
  const out: Array<{ text: string; href: string }> = [];
  const re = /<a\b[^>]*href=["'](https?:\/\/[^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && out.length < 50) {
    const text = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (text) out.push({ text, href: m[1] });
  }
  return out;
}

/** Execute one browser action against a session's page. Pure-ish: all Playwright
 *  access goes through the manager so a fake module tests the full HTTP path. */
export async function executeAction(
  mgr: BrowserContextManager,
  req: ActionRequest,
): Promise<ActionResponse> {
  const key = req.sessionId;
  const a = req.action;
  const base: ActionResponse = { ok: false, action: a.name };
  try {
    const page = await mgr.pageFor(key);
    switch (a.name) {
      case 'navigate': {
        if (!a.url || !/^https?:\/\//i.test(a.url)) {
          return { ...base, error: 'navigate requires an http(s) url', errorCode: 'invalid_request' };
        }
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        // BS-1 D2: domcontentloaded fires BEFORE a client-side app renders, so
        // reading the page right after it returns the empty shell. Settle first
        // (network-idle + DOM-stability, both bounded), then persist + report.
        const settle = await settleAfterNavigate(page);
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url(), settle };
      }
      case 'get_content': {
        const html = await page.content();
        if (a.format === 'html') {
          const c = clip(html);
          return { ...base, ok: true, url: page.url(), ...c };
        }
        const text = htmlToText(html);
        const c = clip(text);
        return { ...base, ok: true, url: page.url(), ...c, links: extractLinks(html) };
      }
      case 'click': {
        if (!a.selector) return { ...base, error: 'click requires a selector', errorCode: 'invalid_request' };
        // BS-1 D2b: a click that routes the app must settle before the caller
        // reads — otherwise get_content returns the empty shell with ok:true.
        const inter = await settleAfterInteraction(page, {
          act: () => page.click(a.selector as string, { timeout: ACT_TIMEOUT_MS }),
        });
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url(), ...(inter.settle ? { settle: inter.settle } : {}) };
      }
      case 'type': {
        if (!a.selector || a.text == null) return { ...base, error: 'type requires selector + text', errorCode: 'invalid_request' };
        // `submit` may navigate (a search form); a plain fill may not. The
        // pre-check inside settleAfterInteraction decides, so `type` without
        // submit pays nothing unless the page actually moved.
        const inter = await settleAfterInteraction(page, {
          act: async () => {
            await page.fill(a.selector as string, a.text as string, { timeout: ACT_TIMEOUT_MS });
            if (a.submit) await page.press(a.selector as string, 'Enter', { timeout: ACT_TIMEOUT_MS });
          },
        });
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url(), ...(inter.settle ? { settle: inter.settle } : {}) };
      }
      case 'scroll': {
        const px = Math.max(0, Math.min(10_000, Math.floor(Number(a.amount ?? 800)) || 0)) || 800;
        const delta = a.direction === 'up' ? -px : px;
        if (a.direction === 'top' || a.direction === 'bottom') {
          await page.evaluate(
            `window.scrollTo(0, ${a.direction === 'top' ? 0 : 'document.body.scrollHeight'})`,
          );
        } else {
          await page.evaluate(`window.scrollBy(0, ${delta})`);
        }
        return { ...base, ok: true, url: page.url() };
      }
      case 'screenshot': {
        const buf = await page.screenshot({ type: 'png', fullPage: false });
        // Cap the base64 payload fed back through the API (review LOW): a huge
        // page screenshot otherwise returns megabytes while text clips at 8k.
        const b64 = buf.toString('base64');
        if (b64.length > 4_000_000) {
          return { ...base, ok: false, error: 'screenshot too large (>3MB raw) — reduce the viewport or scroll before capturing', errorCode: 'screenshot_too_large' };
        }
        return { ...base, ok: true, url: page.url(), screenshotBase64: b64 };
      }
      case 'close': {
        await mgr.closeContext(key);
        return { ...base, ok: true };
      }
      default:
        return { ...base, error: `unsupported action: ${a.name}`, errorCode: 'unsupported_action' };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    // BS-1 D1: the catch-all carries a classified code so the HTTP status is
    // the real one (never a 200 dressing up a failure).
    return { ...base, error: msg.slice(0, 500), errorCode: classifyActionError(msg) };
  }
}

/** Minimal HTML → text (the service ships no cheerio; the model reads text). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(?:br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

// ── HTTP server ──────────────────────────────────────────────────────────────

function readBody(req: http.IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, code: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(payload);
}

export function createServer(mgr: BrowserContextManager): http.Server {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://localhost');
    try {
      if (url.pathname === '/health' && req.method === 'GET') {
        // Review M3: count only — no session keys (unauthenticated endpoint).
        //
        // BS-1 D3 (2026-11-02): this endpoint used to answer 200 unconditionally,
        // so a service with NO BROWSER_SERVICE_SECRET — which can never create a
        // context because every token check fails — reported itself healthy and
        // a deploy wave went green over a completely inert feature. Configured →
        // 200 as before. Unconfigured → 503 with `inert:true`, so the container's
        // own healthcheck (and anything else probing it) sees the truth.
        if (!mgr.configured()) {
          return send(res, 503, {
            ok: false,
            status: 'inert',
            service: 'digby-browser-service',
            reason: 'BROWSER_SERVICE_SECRET unset — every token check fails, so no context can ever be created (set the secret to activate)',
            ...mgr.stats(),
          });
        }
        return send(res, 200, { ok: true, status: 'ready', service: 'digby-browser-service', ...mgr.stats() });
      }

      if (url.pathname === '/v1/action' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed: ActionRequest;
        try { parsed = JSON.parse(raw) as ActionRequest; } catch { return send(res, 400, { error: 'invalid json' }); }
        if (!parsed || typeof parsed.sessionId !== 'string' || !parsed.sessionId || !parsed.action?.name) {
          return send(res, 400, { error: 'sessionId + action.name required' });
        }
        const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!mgr.verifyToken(parsed.sessionId, presented)) {
          return send(res, 401, { error: 'invalid session token' });
        }
        const out = await executeAction(mgr, parsed);
        // BS-1 D1 (2026-11-02): this line used to read
        //   send(res, out.ok || out.error ? 200 : 200, out)
        // — both ternary branches were 200, so a failed navigate, a click that
        // hit nothing and an over-cap screenshot all reported HTTP 200 with the
        // error buried in the body. The status now comes from the outcome.
        return send(res, statusForResponse(out), out);
      }

      if (url.pathname === '/v1/close' && req.method === 'POST') {
        const raw = await readBody(req);
        let parsed: { sessionId?: string };
        try { parsed = JSON.parse(raw) as { sessionId?: string }; } catch { return send(res, 400, { error: 'invalid json' }); }
        const key = parsed?.sessionId;
        if (typeof key !== 'string' || !key) return send(res, 400, { error: 'sessionId required' });
        const presented = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
        if (!mgr.verifyToken(key, presented)) return send(res, 401, { error: 'invalid session token' });
        await mgr.closeContext(key);
        return send(res, 200, { ok: true });
      }

      return send(res, 404, { error: 'not found' });
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      return send(res, 500, { error: msg.slice(0, 300) });
    }
  });
}
