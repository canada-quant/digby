/**
 * Client-error payload sanitizer (ticket d4e643a5, 2026-11-06).
 *
 * WHY: before this ticket NOTHING captured a client-side UI failure — no
 * `window.onerror`, no `unhandledrejection`, no React `componentDidCatch`, and
 * no backend ingest. `app_error_logs` was written only by the backend winston
 * transport, so the hourly log-signal-sweep (fleet/log-signal-sweep.service.ts)
 * was structurally blind to a render crash, a broken click handler or a
 * rejected promise: the owner had to notice it and file by hand.
 *
 * This leaf is the INGEST-side half of the fix: it turns whatever an untrusted
 * browser posts into the small, bounded, credential-free shape that is safe to
 * persist in `app_error_logs`.
 *
 * TRUST MODEL — the client is hostile. The browser side runs the same scrub
 * before sending (frontend/lib/client-error-reporter.ts, so the value never
 * leaves the tab either), but this module re-does ALL of it server-side and the
 * endpoint derives its dedupe key from THIS output, never from the client's
 * claimed `signature`.
 *
 * WHAT A UI ERROR CAN CARRY, and the shape each is cut by:
 *   - user text — a thrown `Error(`${typed message}`)` or a stack quoting a
 *     string literal. Any QUOTED run longer than QUOTED_TEXT_MIN is replaced
 *     with `<text>`: a UI error needs the error TYPE and the failing frame, not
 *     the sentence a human typed.
 *   - credentials — a stack quoting a URL with userinfo, an `Authorization`
 *     header, a fetch init dump, or a provider token echoed by a request
 *     helper. Cut by URL_USERINFO / BARE_TOKEN_USERINFO / GitHub's token
 *     families / the provider prefixes / AWS + Google key bodies / Slack + CF
 *     tokens / JWT triples, plus labelled assignments (`token=…`).
 *   - volume — a render loop can throw the same error thousands of times per
 *     second. Every field is length-capped here, the endpoint throttles per
 *     signature, and the client dedupes per tab.
 *
 * Pure leaf: no imports, no I/O, never throws. The canonical backend secret
 * set (platform/secret-scan.ts `redactSecrets`) is applied ON TOP by the
 * controller — this module deliberately holds only the shapes a browser stack
 * can produce, so it stays import-free and unit-testable in isolation.
 */

/** Longest message kept (the fingerprint cap is 120 chars, the DB column is Text). */
export const CLIENT_ERROR_MAX_MESSAGE = 500;
/** Longest stack kept — enough for a real frame list, far below the 10 000-char DB cut. */
export const CLIENT_ERROR_MAX_STACK = 4_000;
/** Longest page URL kept (query strings are dropped separately). */
export const CLIENT_ERROR_MAX_URL = 300;
/** Longest user agent kept. */
export const CLIENT_ERROR_MAX_USER_AGENT = 300;
/** Longest build/deploy sha kept. */
export const CLIENT_ERROR_MAX_BUILD_SHA = 64;
/** Longest route (pathname) kept. */
export const CLIENT_ERROR_MAX_ROUTE = 200;
/** A quoted run at least this long is treated as user text and masked. */
export const QUOTED_TEXT_MIN = 40;
/** The sanitized `signature` (dedupe key) length. */
export const CLIENT_ERROR_SIGNATURE_MAX = 200;

/** Where the report came from — the closed set the endpoint accepts. */
export const CLIENT_ERROR_SOURCES = ['onerror', 'unhandledrejection', 'error-boundary'] as const;
export type ClientErrorSource = (typeof CLIENT_ERROR_SOURCES)[number];

/** The masked replacement for user-typed text. */
export const CLIENT_ERROR_TEXT_MASK = '<text>';

// ── credential shapes ────────────────────────────────────────────────────────

/** `//user:pass@` or `//token@` inside a URL → `//***@` (host kept). Idempotent via the mask. */
const URL_USERINFO_RE = /(\/\/)(?!\*\*\*@)([^\/@\s'"`]+)@/g;
/** A bare `x-access-token:<token>@` / `oauth2:<token>@` (git's own phrasing keeps no `//`). */
const BARE_TOKEN_USERINFO_RE = /\b(x-access-token|oauth2):(?!\*\*\*@)[^@\s'"`]+@/g;
/** GitHub's public token families (gho_/ghp_/ghs_/ghu_/ghr_/github_pat_). */
const GITHUB_TOKEN_RE = /\b(gho|ghp|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{8,}/g;
/** `Bearer <token>` — a request helper echoing its headers. */
const BEARER_RE = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
/** Provider token prefixes the platform itself uses (sk-, xai-, hf_, xox…, AKIA, AIza, cf_, tskey-). */
const PROVIDER_TOKEN_RE = /\b(sk|xai|hf|o1|csk|gsk|pck|tskey)-[A-Za-z0-9_-]{8,}/g;
const XOX_TOKEN_RE = /\bxox[abposr]-[A-Za-z0-9-]{8,}/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const GOOGLE_KEY_RE = /\bAIza[0-9A-Za-z_-]{30,}/g;
const CF_KEY_RE = /\bcf_[A-Za-z0-9_-]{20,}/g;
/** A JWT triple (header.payload.signature) — the access token in a stack or a fetch dump. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g;
/** `token=…` / `password: …` / `apiKey=…` labelled assignments. */
const LABELLED_SECRET_RE = /\b(password|passwd|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret)\b\s*[:=]\s*("[^"]{0,200}"|'[^']{0,200}'|[^\s,;&"')]{1,200})/gi;

/** A quoted run of QUOTED_TEXT_MIN+ characters — user text inside a thrown message or stack. */
const QUOTED_TEXT_RE = new RegExp(`(["'\`])(?:[^"'\\\`\\\\]|\\\\.){${QUOTED_TEXT_MIN},}\\1`, 'g');

/**
 * AN UNQUOTED USER SENTENCE — the shape the quoted-run rule misses, and the one
 * that actually leaks (adversarial review BLOCKER 1, 2026-11-06).
 *
 * `throw new Error(typedText)` / `Promise.reject(userInput)` produce a message
 * with NO quotes at all: `Error: my daughter has a dentist appointment on
 * Thursday`. The quoted-run rule above cannot see it, so it was length-capped
 * and persisted verbatim — then quoted into the auto-filed ticket description
 * by the sweep. That is the exact class the ticket forbids ("No user message
 * content ... appears in the captured payload").
 *
 * THE RULE: mask a run of ≥ UNQUOTED_MIN_WORDS consecutive alphabetic words
 * (letters + internal apostrophes/hyphens) totalling ≥ UNQUOTED_MIN_CHARS.
 * Word count is the discriminator, not length: a framework error message is
 * SHORT ("Cannot read properties of undefined", "Maximum update depth
 * exceeded") while a sentence a human typed runs on. Digits and code
 * punctuation END a run, so an id or a frame never looks like prose.
 *
 * THE EXEMPTIONS are a small CLOSED set of framework/engine error idioms
 * (DIAGNOSTIC_IDIOMS below) — they are exactly the messages whose text IS the
 * diagnosis and whose fingerprint must stay distinct across components. The set
 * is intentionally tiny and each entry is a prefix of a real message shipped by
 * React or a JS engine; a new entry is a reviewable change, never a wildcard.
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

/** Mask an unquoted natural-language run (see UNQUOTED_* above). Pure, idempotent, never throws. */
export function scrubUnquotedText(text: unknown): string {
  try {
    const s = typeof text === 'string' ? text : String(text ?? '');
    if (!s) return '';
    // A framework diagnostic keeps its text: it is the classification signal.
    if (isDiagnosticMessage(s)) return s;
    // Mask only the run that clears BOTH floors (words AND chars), so a short
    // two-word fragment ("read timeout") is not touched.
    return s.replace(ALPHA_RUN_RE, (run) => (run.length >= UNQUOTED_MIN_CHARS ? CLIENT_ERROR_TEXT_MASK : run));
  } catch {
    return '';
  }
}

/** Every masked shape collapses to this. */
export const CLIENT_ERROR_SECRET_MASK = '***';

/**
 * Mask credential shapes in `text`. Pure, idempotent (`***` and `<text>` match
 * none of the patterns), never throws.
 */
export function scrubClientErrorText(text: unknown): string {
  try {
    const s = typeof text === 'string' ? text : String(text ?? '');
    return s
      // Quoted user text FIRST: a masked run can no longer be mistaken for a
      // token, and a token inside a quoted run is masked by the label/prefix
      // passes anyway (they run on the leftover text).
      .replace(QUOTED_TEXT_RE, (m) => `${m[0]}${CLIENT_ERROR_TEXT_MASK}${m[0]}`)
      .replace(URL_USERINFO_RE, (_m, slashes: string) => `${slashes}${CLIENT_ERROR_SECRET_MASK}@`)
      .replace(BARE_TOKEN_USERINFO_RE, (_m, user: string) => `${user}:${CLIENT_ERROR_SECRET_MASK}@`)
      .replace(GITHUB_TOKEN_RE, (_m, prefix: string) => `${prefix}_${CLIENT_ERROR_SECRET_MASK}`)
      .replace(BEARER_RE, (_m, scheme: string) => `${scheme} ${CLIENT_ERROR_SECRET_MASK}`)
      .replace(PROVIDER_TOKEN_RE, (_m, prefix: string) => `${prefix}-${CLIENT_ERROR_SECRET_MASK}`)
      .replace(XOX_TOKEN_RE, (m) => `${m.slice(0, 4)}-${CLIENT_ERROR_SECRET_MASK}`)
      .replace(AWS_KEY_RE, `AKIA${CLIENT_ERROR_SECRET_MASK}`)
      .replace(GOOGLE_KEY_RE, `AIza${CLIENT_ERROR_SECRET_MASK}`)
      .replace(CF_KEY_RE, `cf_${CLIENT_ERROR_SECRET_MASK}`)
      .replace(JWT_RE, `jwt.${CLIENT_ERROR_SECRET_MASK}`)
      .replace(LABELLED_SECRET_RE, (_m, label: string) => `${label}=${CLIENT_ERROR_SECRET_MASK}`);
  } catch {
    return '';
  }
}

/** Mask + collapse whitespace + cap. The shape every single-line field takes. */
export function boundedClientErrorText(text: unknown, max: number): string {
  try {
    const scrubbed = scrubClientErrorText(text).replace(/\s+/g, ' ').trim();
    return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
  } catch {
    return '';
  }
}

/**
 * A MULTI-LINE field (the stack) — adversarially-reviewed defect MAJOR 2
 * (2026-11-06): the single-line helper collapsed every newline to a space, so
 * `firstStackFrame` (which looks for a line starting `at `) could never find
 * one. The consequence was worse than cosmetic:
 *   - `app_error_logs.stack` became one unreadable blob with no frame list —
 *     the column's entire purpose, and what a triage lane reads;
 *   - the signature's frame half was ALWAYS empty, so two unrelated faults
 *     sharing a message string collided into one dedupe key and the second was
 *     throttled away for 5 minutes.
 * Newlines are preserved; horizontal whitespace is still collapsed; scrubbing
 * and the cap are unchanged.
 */
export function boundedClientErrorStack(text: unknown, max: number): string {
  try {
    const scrubbed = scrubClientErrorText(text)
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\f\v]+/g, ' ')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l, i, all) => l.length > 0 || (i > 0 && all[i - 1].length > 0)) // drop runs of blank lines, keep one
      .join('\n')
      .trim();
    return scrubbed.length > max ? scrubbed.slice(0, max) : scrubbed;
  } catch {
    return '';
  }
}

/**
 * The page URL as something safe to store: origin + pathname only — the query
 * string and the fragment are dropped (a `?token=` or a search term lives
 * there), credentials are masked, and the whole thing is capped.
 */
export function sanitizeClientErrorUrl(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return undefined;
  let shaped = s;
  try {
    const u = new URL(s);
    shaped = `${u.origin}${u.pathname}`;
  } catch {
    // Not an absolute URL (a relative path, or junk) — take the pre-'?' part.
    shaped = s.split(/[?#]/)[0];
  }
  const out = boundedClientErrorText(shaped, CLIENT_ERROR_MAX_URL);
  return out || undefined;
}

/** Lowercase hex-ish token — build/deploy shas, never free text. */
export function sanitizeClientErrorBuildSha(raw: unknown): string | undefined {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return undefined;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) return undefined;
  return s.slice(0, CLIENT_ERROR_MAX_BUILD_SHA);
}

/** The first stack frame's function+location — the stable half of a signature. */
export function firstStackFrame(stack: string | undefined): string {
  const s = typeof stack === 'string' ? stack : '';
  const line = s.split('\n').map((l) => l.trim()).find((l) => /^at\s/.test(l));
  return line ? line.slice(0, 120) : '';
}

/**
 * The dedupe key: message + first stack frame with the volatile parts stripped
 * (same discipline as the sweep's normalizeLogMessage — ids/uuids/hex/numbers/
 * timestamps vary per occurrence, the CLASS must not). Pure.
 */
export function clientErrorSignature(message: string, stack?: string): string {
  const normalized = String(message ?? '')
    .replace(/\u001b\[\d+m/g, '')
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<uuid>')
    .replace(/\b[0-9a-f]{16,}\b/gi, '<hex>')
    .replace(/\d+(?:\.\d+)?/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const frame = firstStackFrame(stack).replace(/\d+(?:\.\d+)?/g, '<n>');
  return `${normalized} @ ${frame}`.slice(0, CLIENT_ERROR_SIGNATURE_MAX);
}

/** What a caller may post (already bounded by the zod schema at the route). */
export interface RawClientErrorInput {
  message?: unknown;
  stack?: unknown;
  url?: unknown;
  userAgent?: unknown;
  buildSha?: unknown;
  route?: unknown;
  source?: unknown;
  /** How many occurrences the tab collapsed into this report (informational). */
  occurrences?: unknown;
  line?: unknown;
  column?: unknown;
}

/** The bounded, credential-free shape the endpoint persists. */
export interface SanitizedClientError {
  message: string;
  stack?: string;
  url?: string;
  userAgent?: string;
  buildSha?: string;
  route?: string;
  source: ClientErrorSource | string;
  occurrences: number;
  line?: number;
  column?: number;
  signature: string;
}

const int = (v: unknown, max: number): number | undefined => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), max);
};

/**
 * Sanitize one posted client error. Pure; never throws. `message` empty after
 * scrubbing ⇒ the caller drops the report (nothing identifiable to record).
 */
export function sanitizeClientError(input: RawClientErrorInput): SanitizedClientError {
  // The MESSAGE takes both masks: quoted user text AND an unquoted sentence
  // (BLOCKER 1 — `throw new Error(typedText)` carries no quotes at all).
  const message = boundedClientErrorText(scrubUnquotedText(input.message), CLIENT_ERROR_MAX_MESSAGE);
  // The STACK keeps its newlines (MAJOR 2) so the frame list survives and
  // firstStackFrame can find one. It still goes through the credential masks
  // and the unquoted-sentence rule, but NEVER the whitespace collapse.
  const stackRaw = boundedClientErrorStack(input.stack, CLIENT_ERROR_MAX_STACK);
  const stack = stackRaw || undefined;
  const source = CLIENT_ERROR_SOURCES.includes(input.source as ClientErrorSource)
    ? String(input.source)
    : 'onerror';
  const routeRaw = typeof input.route === 'string' ? input.route.split(/[?#]/)[0] : '';
  const route = boundedClientErrorText(routeRaw, CLIENT_ERROR_MAX_ROUTE) || undefined;
  const occurrencesRaw = int(input.occurrences, 10_000);
  const url = sanitizeClientErrorUrl(input.url);
  const userAgent = boundedClientErrorText(input.userAgent, CLIENT_ERROR_MAX_USER_AGENT);
  const buildSha = sanitizeClientErrorBuildSha(input.buildSha);
  const line = int(input.line, 10_000_000);
  const column = int(input.column, 10_000_000);
  return {
    message,
    ...(stack ? { stack } : {}),
    ...(url ? { url } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...(buildSha ? { buildSha } : {}),
    ...(route ? { route } : {}),
    source,
    occurrences: occurrencesRaw && occurrencesRaw > 0 ? occurrencesRaw : 1,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
    signature: clientErrorSignature(message, stack),
  };
}