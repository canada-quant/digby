/**
 * URL-embedded credential redaction — a LEAF (no imports; safe from logger.ts
 * and from the coding module alike).
 *
 * WHY (backlog audit T7): git echoes its full argv into an execFile error
 * (`Command failed: git remote set-url origin https://x-access-token:<token>@…`),
 * so a caught mirror / clone / fetch / push error carried the token straight
 * into `logger.warn(...)` and from there into `app_error_logs` (11 rows, two
 * distinct long-lived OAuth user tokens). The remote config was scrubbed on
 * disk (workspace.service finally block) but never the log line.
 *
 * TWO seams use this:
 *  1. `coding/workspace.service.ts git()` rethrows every git failure with its
 *     message / stack / cmd / stderr / stdout run through `redactGitError` —
 *     one place for every caller (mirror, clone, fetch, worktree, history sync).
 *  2. `utils/logger.ts` runs every log record (message, stack, string leaves
 *     of the metadata) through `redactUrlCredentials` as the LAST line of
 *     defence before the console + app_error_logs transports.
 * Both fail OPEN: any throw returns the input unchanged.
 *
 * SHAPES: `scheme://<userinfo>@host` (user:pass or a bare token as the user
 * part — GitHub accepts both) → `scheme://***@host`; a bare
 * `x-access-token:<token>@` / `oauth2:<token>@` (git's own `fatal: unable to
 * access 'https://x-access-token:…'` phrasing keeps the `//`, but a stderr
 * line may quote only the userinfo) → `x-access-token:***@`. Deliberately NOT
 * a general secret scan — that is `platform/secret-scan.ts`; this module only
 * knows the URL-credential shape a git command line can carry.
 *
 * Existing rows: `scripts/framework-audit/scrub-error-log-credentials.js`
 * (dry-run default, `--apply` writes) rewrites app_error_logs through the
 * same function.
 */

/** `//user:pass@` or `//token@` inside a URL → `//***@` (host kept). The
 *  mask itself (`//***@`) is excluded so the function is idempotent and an
 *  already-scrubbed row never reads as a credential again. */
const URL_USERINFO_RE = /(\/\/)(?!\*\*\*@)([^\/@\s'"`]+)@/g;
/** A bare `x-access-token:<token>@` / `oauth2:<token>@` (no `//` in front). */
const BARE_TOKEN_USERINFO_RE = /\b(x-access-token|oauth2):(?!\*\*\*@)[^@\s'"`]+@/g;
/**
 * A bare GitHub token ANYWHERE in text (d6110694: a caught git error quoted
 * the token outside any URL — `remote set-url` argv, stderr prose). The
 * prefixes are GitHub's public token families (gho_ OAuth user, ghp_ PAT,
 * ghs_ server, ghu_ app user-to-server, ghr_ refresh, github_pat_ fine-grained
 * PAT); ≥8 body chars keeps sha/email/host:port prose false-positive-free.
 * Idempotent by construction: `***` is outside [A-Za-z0-9_].
 */
const GITHUB_TOKEN_PREFIX_RE = /\b(gho|ghp|ghs|ghu|ghr|github_pat)_[A-Za-z0-9_]{8,}/g;

export const CREDENTIAL_MASK = '***';

/** True when `text` carries a URL-embedded credential this module would mask. */
export function hasUrlCredentials(text: unknown): boolean {
  const s = String(text ?? '');
  URL_USERINFO_RE.lastIndex = 0;
  BARE_TOKEN_USERINFO_RE.lastIndex = 0;
  GITHUB_TOKEN_PREFIX_RE.lastIndex = 0;
  const hit = URL_USERINFO_RE.test(s) || BARE_TOKEN_USERINFO_RE.test(s) || GITHUB_TOKEN_PREFIX_RE.test(s);
  URL_USERINFO_RE.lastIndex = 0;
  BARE_TOKEN_USERINFO_RE.lastIndex = 0;
  GITHUB_TOKEN_PREFIX_RE.lastIndex = 0;
  return hit;
}

/**
 * Mask every URL-embedded credential in `text`. Pure; never throws (a
 * non-string is stringified; a throw returns the input as a string).
 */
export function redactUrlCredentials(text: unknown): string {
  const s = typeof text === 'string' ? text : String(text ?? '');
  try {
    URL_USERINFO_RE.lastIndex = 0;
    BARE_TOKEN_USERINFO_RE.lastIndex = 0;
    GITHUB_TOKEN_PREFIX_RE.lastIndex = 0;
    return s
      .replace(URL_USERINFO_RE, (_m, slashes: string) => `${slashes}${CREDENTIAL_MASK}@`)
      .replace(BARE_TOKEN_USERINFO_RE, (_m, user: string) => `${user}:${CREDENTIAL_MASK}@`)
      .replace(GITHUB_TOKEN_PREFIX_RE, (_m, prefix: string) => `${prefix}_${CREDENTIAL_MASK}`);
  } catch {
    return s;
  }
}

/**
 * Mask URL credentials in every STRING LEAF of a value (plain objects and
 * arrays walked, depth ≤ 12; Errors get message + stack; anything else passes
 * through untouched). Returns a NEW structure only when something changed —
 * an untouched input is returned by identity so the logger's hot path stays
 * allocation-free. Never throws.
 */
export function redactUrlCredentialsDeep<T>(value: T): T {
  try {
    let changed = false;
    const walk = (v: unknown, depth: number): unknown => {
      if (typeof v === 'string') {
        if (!hasUrlCredentials(v)) return v;
        changed = true;
        return redactUrlCredentials(v);
      }
      if (depth >= 12 || v === null || typeof v !== 'object') return v;
      if (v instanceof Error) {
        if (!hasUrlCredentials(v.message) && !hasUrlCredentials(v.stack)) return v;
        changed = true;
        return redactGitError(v);
      }
      if (Array.isArray(v)) {
        const next = v.map((x) => walk(x, depth + 1));
        return changed ? next : v;
      }
      const proto = Object.getPrototypeOf(v);
      if (proto !== Object.prototype && proto !== null) return v; // Date, Map, class instances…
      const o: Record<string, unknown> = {};
      let localChange = false;
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        const y = walk(x, depth + 1);
        if (y !== x) localChange = true;
        o[k] = y;
      }
      return localChange ? o : v;
    };
    const out = walk(value, 0) as T;
    return changed ? out : value;
  } catch {
    return value;
  }
}

/**
 * Scrub the credential-bearing fields of a child_process / git error IN PLACE
 * and return the same object (code, signal, killed and every other property
 * survive — callers still branch on them). `message`, `stack`, `cmd`,
 * `stderr` and `stdout` are the fields execFile fills with the command line
 * and git's own output. A non-object input is returned untouched. Never
 * throws.
 */
export function redactGitError<E>(err: E): E {
  try {
    if (!err || typeof err !== 'object') return err;
    const e = err as Record<string, unknown>;
    for (const field of ['message', 'stack', 'cmd', 'stderr', 'stdout'] as const) {
      const v = e[field];
      const s = typeof v === 'string' ? v : Buffer.isBuffer(v) ? v.toString() : null;
      if (s === null || !hasUrlCredentials(s)) continue;
      try {
        // Plain assignment keeps each field's own enumerability (Error.message
        // / .stack are non-enumerable own props; cmd / stderr / stdout are plain).
        e[field] = redactUrlCredentials(s);
      } catch { /* read-only field — the logger seam still masks it */ }
    }
    return err;
  } catch {
    return err;
  }
}
