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
}

const MAX_CONTENT_CHARS = 8000;
const NAV_TIMEOUT_MS = 45_000;
const ACT_TIMEOUT_MS = 20_000;

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
          return { ...base, error: 'navigate requires an http(s) url' };
        }
        await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT_MS });
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url() };
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
        if (!a.selector) return { ...base, error: 'click requires a selector' };
        await page.click(a.selector, { timeout: ACT_TIMEOUT_MS });
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url() };
      }
      case 'type': {
        if (!a.selector || a.text == null) return { ...base, error: 'type requires selector + text' };
        await page.fill(a.selector, a.text, { timeout: ACT_TIMEOUT_MS });
        if (a.submit) await page.press(a.selector, 'Enter', { timeout: ACT_TIMEOUT_MS });
        await mgr.persist(key);
        return { ...base, ok: true, url: page.url() };
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
          return { ...base, ok: false, error: 'screenshot too large (>3MB raw) — reduce the viewport or scroll before capturing' };
        }
        return { ...base, ok: true, url: page.url(), screenshotBase64: b64 };
      }
      case 'close': {
        await mgr.closeContext(key);
        return { ...base, ok: true };
      }
      default:
        return { ...base, error: `unsupported action: ${a.name}` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ...base, error: msg.slice(0, 500) };
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
        return send(res, 200, { ok: true, service: 'digby-browser-service', ...mgr.stats() });
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
        return send(res, out.ok || out.error ? 200 : 200, out);
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
