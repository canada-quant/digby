/**
 * Client-side UI error capture (ticket d4e643a5, 2026-11-06).
 *
 * The owner, verbatim, on ticket 81b229e1: "also you should;d be capturing all
 * these ui errors somewhere and auto filing tickets without me telling you
 * right?"
 *
 * THE GAP THIS CLOSES: nothing in the frontend ever LEFT the tab. There was no
 * `window.onerror`, no `unhandledrejection`, no React `componentDidCatch` and no
 * ingest endpoint — `app/error.tsx` did `console.error` and nothing more. So a
 * render crash, a broken click handler or a rejected promise reached the browser
 * console only, and because `app_error_logs` had exactly ONE producer (the
 * backend winston transport) the hourly log-signal-sweep was structurally unable
 * to see a client error: the owner had to notice it and file by hand.
 *
 * WHAT THIS DOES: one install of two window listeners plus a report seam for the
 * React boundaries, posting a SMALL purpose-built payload to
 * `POST /api/crossmodel/client-error`. The backend writes it through the
 * existing winston logger into `app_error_logs` stamped `source: 'client-error'`,
 * and the EXISTING hourly sweep auto-files it — there is deliberately no second
 * filer anywhere in this change.
 *
 * WHAT MUST NEVER BE SENT (a UI error's text is full of user content):
 *   - a thrown `Error(\`${typedMessage}\`)` carries the user's words, and a
 *     stack can quote a string literal ⇒ every quoted run ≥ QUOTED_TEXT_MIN is
 *     replaced with `<text>` BEFORE anything leaves the tab;
 *   - a token in a URL, an Authorization header dump or a provider error ⇒ the
 *     credential shapes are masked here (and again on the server, which is the
 *     authority — this client scrub exists so the value never leaves the
 *     browser either);
 *   - the URL's query string and fragment are dropped (a `?token=` or a search
 *     term lives there) — only origin + pathname are sent;
 *   - nothing else is read: no cookies, no headers, no request bodies, not the
 *     chat transcript. There is no code path here that can see them.
 *
 * WHAT MUST NEVER HAPPEN TO THE USER: a crash must not become a second crash.
 * Every function is total (never throws), the transport is fire-and-forget, the
 * per-tab dedupe collapses a render loop into one request per window, and a
 * refused/throttled report is silently dropped — never retried, never surfaced.
 *
 * Kill switch: NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED=1 (frontend BUILD arg)
 * installs nothing and sends nothing. The server has its own:
 * CLIENT_ERROR_INGEST_DISABLED=1.
 */

/** The ingest path (backend: modules/crossmodel/client-errors). */
export const CLIENT_ERROR_ENDPOINT = '/api/crossmodel/client-error';

export type ClientErrorSource = 'onerror' | 'unhandledrejection' | 'error-boundary';

/** Longest message sent (the server caps at the same number). */
export const MAX_MESSAGE = 500;
/** Longest stack sent. */
export const MAX_STACK = 4_000;
/** Longest page URL / route / user agent sent. */
export const MAX_URL = 300;
export const MAX_ROUTE = 200;
export const MAX_USER_AGENT = 300;
/** A quoted run at least this long is treated as user text and masked. */
export const QUOTED_TEXT_MIN = 40;
/** At most ONE request per signature per this window (a render loop must not chatter). */
export const SIGNATURE_WINDOW_MS = 2 * 60 * 1000;
/** At most this many DISTINCT reports per tab per minute (a broken page must not flood). */
export const MAX_REPORTS_PER_MINUTE = 8;
/** Hard cap per page load — the backstop if the rate window itself misbehaves. */
export const MAX_REPORTS_PER_PAGE = 40;
/** Bound on the memory the dedupe map may take. */
export const MAX_SIGNATURES = 200;

export const TEXT_MASK = '<text>';
export const SECRET_MASK = '***';

/** The slice of the environment these readers need — NOT ProcessEnv (the
 *  frontend's ProcessEnv requires NODE_ENV, which forces every caller and test
 *  into a lying cast; a reader that reads one key should ask for one key). */
export type ClientErrorEnv = Record<string, string | undefined>;

/** Build-time switch (`next build` inlines NEXT_PUBLIC_*). */
export function clientErrorReportDisabled(env: ClientErrorEnv = process.env): boolean {
  return env.NEXT_PUBLIC_CLIENT_ERROR_REPORT_DISABLED === '1';
}

/** The deploy sha this bundle was built from (frontend/Dockerfile: ARG DEPLOY_SHA ⇒ NEXT_PUBLIC_DEPLOY_SHA). */
export function clientBuildSha(env: ClientErrorEnv = process.env): string | undefined {
  const s = String(env.NEXT_PUBLIC_DEPLOY_SHA ?? '').trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(s) ? s : undefined;
}

// ── scrubbing (mirrors backend client-errors/client-error-sanitize.ts) ───────

const URL_USERINFO_RE = /(\/\/)(?!\*\*\*@)([^\/@\s'"`]+)@/g;
const BARE_TOKEN_USERINFO_RE = /\b(x-access-token|oauth2):(?!\*\*\*@)[^@\s'"`]+@/g;
const GITHUB_TOKEN_RE = /\b(gho|ghp|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{8,}/g;
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const PROVIDER_TOKEN_RE = /\b(sk|xai|hf|o1|csk|gsk|pck|tskey)-[A-Za-z0-9_-]{8,}/g;
const XOX_TOKEN_RE = /\bxox[abposr]-[A-Za-z0-9-]{8,}/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{30,}/g;
const CF_KEY_RE = /\bcf_[A-Za-z0-9_-]{20,}/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
const LABELLED_SECRET_RE = /\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*("[^"]{0,200}"|'[^']{0,200}'|[^\s,;&"')]{1,200})/gi;
const QUOTED_TEXT_RE = new RegExp(`(["'\`])(?:[^"'\\\`\\\\]|\\\\.){${QUOTED_TEXT_MIN},}\\1`, 'g');

/**
 * UNQUOTED USER SENTENCE — the leak the quoted-run rule misses (adversarial
 * review BLOCKER 1, 2026-11-06; the server twin is in
 * backend client-errors/client-error-sanitize.ts). `throw new Error(typedText)`
 * and `Promise.reject(userInput)` carry NO quotes, so the quoted rule never
 * fired and the sentence shipped verbatim. Mirrored here so it never leaves the
 * tab in the first place; the server re-applies it and remains the authority.
 */
export const UNQUOTED_MIN_WORDS = 5;
export const UNQUOTED_MIN_CHARS = 25;
const ALPHA_RUN_RE = new RegExp(`[A-Za-z][A-Za-z'-]*(?: [A-Za-z][A-Za-z'-]*){${UNQUOTED_MIN_WORDS - 1},}`, 'g');
const DIAGNOSTIC_IDIOMS: readonly RegExp[] = [
  /cannot read propert/i,
  /cannot access /i,
  /maximum update depth/i,
  /objects? are not valid as a react child/i,
  /invalid hook call/i,
  /rendered (?:more|fewer) hooks/i,
  /too many re-renders/i,
  /is not a function/i,
  /is not defined/i,
  /is not iterable/i,
  /minified react error/i,
  /the above error occurred/i,
];

/** True when the message IS a framework diagnostic (its text is the diagnosis, not user content). */
export function isDiagnosticMessage(message: string): boolean {
  const body = String(message ?? '').replace(/^[A-Za-z]*Error:\s*/, '');
  return DIAGNOSTIC_IDIOMS.some((re) => re.test(body));
}

/** Mask an unquoted natural-language run. Pure, idempotent, never throws. */
export function scrubUnquotedText(text: unknown): string {
  try {
    const s = typeof text === 'string' ? text : String(text ?? '');
    if (!s) return '';
    if (isDiagnosticMessage(s)) return s;
    return s.replace(ALPHA_RUN_RE, (run) => (run.length >= UNQUOTED_MIN_CHARS ? TEXT_MASK : run));
  } catch {
    return '';
  }
}

/** Mask user text + credential shapes. Pure, idempotent, never throws. */
export function scrubClientErrorText(text: unknown): string {
  try {
    const s = typeof text === 'string' ? text : String(text ?? '');
    return s
      .replace(QUOTED_TEXT_RE, (m) => `${m[0]}${TEXT_MASK}${m[0]}`)
      .replace(URL_USERINFO_RE, (_m, slashes: string) => `${slashes}${SECRET_MASK}@`)
      .replace(BARE_TOKEN_USERINFO_RE, (_m, user: string) => `${user}:${SECRET_MASK}@`)
      .replace(GITHUB_TOKEN_RE, (_m, prefix: string) => `${prefix}_${SECRET_MASK}`)
      .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${SECRET_MASK}`)
      .replace(PROVIDER_TOKEN_RE, (_m, prefix: string) => `${prefix}-${SECRET_MASK}`)
      .replace(XOX_TOKEN_RE, (m) => `${m.slice(0, 4)}-${SECRET_MASK}`)
      .replace(AWS_KEY_RE, `AKIA${SECRET_MASK}`)
      .replace(GOOGLE_KEY_RE, `AIza${SECRET_MASK}`)
      .replace(CF_KEY_RE, `cf_${SECRET_MASK}`)
      .replace(JWT_RE, `jwt.${SECRET_MASK}`)
      .replace(LABELLED_SECRET_RE, (_m, label: string) => `${label}=${SECRET_MASK}`);
  } catch {
    return '';
  }
}

/** Mask + collapse whitespace + cap. Single-line fields only. */
export function bounded(text: unknown, max: number): string {
  try {
    const s = scrubClientErrorText(text).replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '';
  }
}

/**
 * Multi-line (the stack) — the newline-collapsing twin of the bug the reviewer
 * caught server-side (MAJOR 2, 2026-11-06): collapsing `\n` to a space made
 * `firstStackFrame` unfindable and shipped the tab a frame-less blob, so the
 * server could not recover a frame from it either. Newlines preserved.
 */
export function boundedStack(text: unknown, max: number): string {
  try {
    const s = scrubClientErrorText(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .split('\n').map((l) => l.trimEnd()).filter((l, i, all) => l.length > 0 || (i > 0 && all[i - 1].length > 0))
      .join('\n').trim();
    return s.length > max ? s.slice(0, max) : s;
  } catch {
    return '';
  }
}

/** Origin + pathname only — the query string and fragment never leave the tab. */
export function sanitizeUrl(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return undefined;
  let shaped = s;
  try {
    const u = new URL(s);
    shaped = `${u.origin}${u.pathname}`;
  } catch {
    shaped = s.split(/[?#]/)[0];
  }
  return bounded(shaped, MAX_URL) || undefined;
}

/** First `at …` frame — the stable half of the signature. */
export function firstStackFrame(stack: string | undefined): string {
  const s = typeof stack === 'string' ? stack : '';
  const line = s.split('\n').map((l) => l.trim()).find((l) => /^at\s/.test(l));
  return line ? line.slice(0, 120) : '';
}

/** The dedupe/signature key: message + first frame with volatile parts stripped. */
export function clientErrorSignature(message: string, stack?: string): string {
  const normalized = String(message ?? '')
    .replace(/\u001b\[\d+m/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  return `${normalized} @ ${firstStackFrame(stack).replace(/\d+(?:\.\d+)?/g, '<n>')}`.slice(0, 200);
}

/** Everything the reporter may know about one failure. */
export interface ClientErrorInput {
  message: unknown;
  stack?: unknown;
  source: ClientErrorSource;
  url?: unknown;
  route?: unknown;
  userAgent?: unknown;
  buildSha?: string;
  line?: number;
  column?: number;
}

/** The exact body posted (a closed set of bounded, scrubbed strings). */
export interface ClientErrorBody {
  message: string;
  source: ClientErrorSource;
  stack?: string;
  url?: string;
  route?: string;
  userAgent?: string;
  buildSha?: string;
  line?: number;
  column?: number;
}

/** Build the posted body. Pure; never throws; empty when there is nothing to say. */
export function clientErrorBody(input: ClientErrorInput): ClientErrorBody | null {
  try {
    // Both masks on the MESSAGE: quoted user text AND an unquoted sentence
    // (BLOCKER 1). The STACK keeps newlines (MAJOR 2).
    const message = bounded(scrubUnquotedText(input.message), MAX_MESSAGE);
    if (!message) return null;
    const stack = boundedStack(input.stack, MAX_STACK) || undefined;
    const url = sanitizeUrl(input.url);
    const route = bounded(String(input.route ?? '').split(/[?#]/)[0], MAX_ROUTE) || undefined;
    const userAgent = bounded(input.userAgent, MAX_USER_AGENT) || undefined;
    const line = Number.isFinite(input.line) && (input.line as number) >= 0 ? Math.floor(input.line as number) : undefined;
    const column = Number.isFinite(input.column) && (input.column as number) >= 0 ? Math.floor(input.column as number) : undefined;
    return {
      message,
      source: input.source,
      ...(stack ? { stack } : {}),
      ...(url ? { url } : {}),
      ...(route ? { route } : {}),
      ...(userAgent ? { userAgent } : {}),
      ...(input.buildSha ? { buildSha: input.buildSha } : {}),
      ...(line !== undefined ? { line } : {}),
      ...(column !== undefined ? { column } : {}),
    };
  } catch {
    return null;
  }
}

/** Pull {message, stack} out of whatever a rejection/throw actually handed us. */
export function describeThrown(reason: unknown): { message: string; stack?: string } {
  try {
    if (reason instanceof Error) {
      return { message: `${reason.name || 'Error'}: ${reason.message}`, ...(reason.stack ? { stack: reason.stack } : {}) };
    }
    if (typeof reason === 'string') return { message: reason };
    if (reason && typeof reason === 'object') {
      const r = reason as { message?: unknown; stack?: unknown; name?: unknown };
      const msg = typeof r.message === 'string' ? r.message : '';
      const name = typeof r.name === 'string' ? r.name : '';
      const label = [name, msg].filter(Boolean).join(': ');
      return {
        message: label || safeStringify(reason),
        ...(typeof r.stack === 'string' ? { stack: r.stack } : {}),
      };
    }
    return { message: String(reason ?? 'Unknown error') };
  } catch {
    return { message: 'Unknown error' };
  }
}

function safeStringify(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    return s && s !== '{}' ? s : 'Unknown error';
  } catch {
    return 'Unknown error';
  }
}

// ── per-tab dedupe + budget ─────────────────────────────────────────────────

/** Transport seam (injected in tests; the real one uses sendBeacon/fetch). */
export interface ClientErrorTransport {
  sendBeacon?: (url: string, data: Blob | string) => boolean;
  fetch?: (url: string, init: RequestInit) => Promise<unknown>;
}

interface ReporterState {
  lastBySignature: Map<string, number>;
  windowStart: number;
  windowCount: number;
  pageCount: number;
}

/** The reporter's module state — one per tab (the module is a singleton in the bundle). */
const state: ReporterState = { lastBySignature: new Map(), windowStart: 0, windowCount: 0, pageCount: 0 };

/** Test seam: forget the dedupe/budget state. */
export function __resetClientErrorReporter(): void {
  state.lastBySignature.clear();
  state.windowStart = 0;
  state.windowCount = 0;
  state.pageCount = 0;
}

/** Test seam: how many signatures are being tracked. */
export function __clientErrorSignatureCount(): number {
  return state.lastBySignature.size;
}

export type ReportOutcome = 'sent' | 'duplicate' | 'rate-limited' | 'disabled' | 'empty' | 'no-transport';

/**
 * Report one client error. Fire-and-forget; never throws, never returns a
 * promise the caller must handle. The same signature is sent at most once per
 * SIGNATURE_WINDOW_MS, and the tab has a per-minute and per-page budget — a
 * render loop becomes ONE request, not thousands.
 */
export function reportClientError(
  input: ClientErrorInput,
  transport?: ClientErrorTransport,
  now: number = Date.now(),
  env: ClientErrorEnv = process.env,
): ReportOutcome {
  try {
    if (clientErrorReportDisabled(env)) return 'disabled';
    const body = clientErrorBody(input);
    if (!body) return 'empty';

    if (state.pageCount >= MAX_REPORTS_PER_PAGE) return 'rate-limited';
    if (now - state.windowStart >= 60_000) { state.windowStart = now; state.windowCount = 0; }
    if (state.windowCount >= MAX_REPORTS_PER_MINUTE) return 'rate-limited';

    const signature = clientErrorSignature(body.message, body.stack);
    const last = state.lastBySignature.get(signature);
    if (last !== undefined && now - last < SIGNATURE_WINDOW_MS) return 'duplicate';

    // Record the attempt BEFORE sending: a transport that throws must not let a
    // crash loop re-enter and try again on every frame.
    if (state.lastBySignature.size >= MAX_SIGNATURES) {
      for (const [k, at] of state.lastBySignature) if (now - at >= SIGNATURE_WINDOW_MS) state.lastBySignature.delete(k);
      if (state.lastBySignature.size >= MAX_SIGNATURES) state.lastBySignature.clear();
    }
    state.lastBySignature.set(signature, now);
    state.windowCount++;
    state.pageCount++;

    return deliver(JSON.stringify(body), transport) ? 'sent' : 'no-transport';
  } catch {
    return 'empty';
  }
}

/** Hand the JSON to the browser. sendBeacon first (survives a closing tab), else fetch keepalive. */
function deliver(payload: string, transport?: ClientErrorTransport): boolean {
  try {
    const sendBeacon = transport?.sendBeacon ?? (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function' ? navigator.sendBeacon.bind(navigator) : undefined);
    if (sendBeacon) {
      try {
        if (sendBeacon(CLIENT_ERROR_ENDPOINT, new Blob([payload], { type: 'application/json' }))) return true;
      } catch { /* fall through to fetch */ }
    }
    const f = transport?.fetch ?? (typeof fetch === 'function' ? fetch : undefined);
    if (!f) return false;
    void Promise.resolve(f(CLIENT_ERROR_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload,
      keepalive: true,
      credentials: 'include',
    })).catch(() => { /* a crash report must never surface its own failure */ });
    return true;
  } catch {
    return false;
  }
}

// ── window listeners ────────────────────────────────────────────────────────

/** The few window members the installer touches (so a test needs no DOM). */
export interface ReportableWindow {
  location?: { href?: string; pathname?: string };
  navigator?: { userAgent?: string };
  addEventListener?: (type: string, listener: (event: any) => void) => void;
  removeEventListener?: (type: string, listener: (event: any) => void) => void;
}

/** The two listeners, exposed so the component can add/remove exactly these. */
export function makeErrorListener(transport?: ClientErrorTransport): (event: any) => void {
  return (event: any) => {
    try {
      const thrown = event?.error !== undefined && event.error !== null ? event.error : event?.message;
      const described = describeThrown(thrown);
      reportClientError({
        message: described.message,
        stack: described.stack ?? event?.error?.stack,
        source: 'onerror',
        url: event?.filename || currentHref(),
        route: currentPath(),
        userAgent: currentUserAgent(),
        buildSha: clientBuildSha(),
        line: typeof event?.lineno === 'number' ? event.lineno : undefined,
        column: typeof event?.colno === 'number' ? event.colno : undefined,
      }, transport);
    } catch { /* never rethrow from a global handler */ }
  };
}

export function makeRejectionListener(transport?: ClientErrorTransport): (event: any) => void {
  return (event: any) => {
    try {
      const described = describeThrown(event?.reason);
      reportClientError({
        message: described.message,
        stack: described.stack,
        source: 'unhandledrejection',
        url: currentHref(),
        route: currentPath(),
        userAgent: currentUserAgent(),
        buildSha: clientBuildSha(),
      }, transport);
    } catch { /* never rethrow from a global handler */ }
  };
}

function currentHref(): string | undefined {
  try { return typeof window !== 'undefined' ? window.location?.href : undefined; } catch { return undefined; }
}
function currentPath(): string | undefined {
  try { return typeof window !== 'undefined' ? window.location?.pathname : undefined; } catch { return undefined; }
}
function currentUserAgent(): string | undefined {
  try { return typeof navigator !== 'undefined' ? navigator.userAgent : undefined; } catch { return undefined; }
}

/**
 * Install both listeners; returns the uninstall. React 18/19 StrictMode mounts,
 * unmounts and re-mounts, and each mount builds NEW closures — `addEventListener`
 * does NOT de-duplicate them, so a dropped teardown would leave a second
 * listener reporting every error twice. The component therefore installs once
 * per mount and always tears down on unmount; the returned teardown removes
 * exactly the functions this call added.
 */
export function installClientErrorReporter(win: ReportableWindow | undefined = typeof window !== 'undefined' ? window : undefined, transport?: ClientErrorTransport): () => void {
  const noop = () => {};
  try {
    if (!win || typeof win.addEventListener !== 'function') return noop;
    const onError = makeErrorListener(transport);
    const onRejection = makeRejectionListener(transport);
    win.addEventListener('error', onError);
    win.addEventListener('unhandledrejection', onRejection);
    return () => {
      try {
        if (typeof win.removeEventListener === 'function') {
          win.removeEventListener('error', onError);
          win.removeEventListener('unhandledrejection', onRejection);
        }
      } catch { /* teardown never throws */ }
    };
  } catch {
    return noop;
  }
}