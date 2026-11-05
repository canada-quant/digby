/**
 * OpenAPI route scanner — discovers the Express route surface by READING the
 * route source files (no app boot, no DB) and builds an OpenAPI 3.x spec.
 *
 * Deliberately regex/paren-matcher based ("AST-light"), not a TS AST walk: the
 * modules follow consistent patterns —
 *
 *   app.ts:            app.use('<prefix>', <routerIdent>) mounts, in order; a
 *                      bare app.use('<prefix>', authenticate) line is the
 *                      single app-level guard — routers mounted at the same
 *                      prefix AFTER it inherit `authenticate`.
 *   *.routes.ts:       const router = Router() (or export const xRoutes =
 *                      Router()), then router.METHOD('<path>', ...middleware,
 *                      handler) and router.use('<sub>', <subRouterIdent>).
 *                      router.use(<middleware>) without a path applies to every
 *                      route in that router.
 *
 * One level of router.use('<sub>', otherRouter) indirection is followed by
 * plain recursion (crossmodel-open.routes.ts mounts the integration
 * sub-routers; those mount nothing further).
 *
 * Comments are blanked out (length-preserving) before call matching so prose
 * like "never add `router.use(authenticate)`" in docblocks can't register as
 * code; the original text is still used for leading-comment extraction (the
 * blanking preserves indices).
 *
 * Metadata per operation:
 *   - summary: leading `summary:` line from a @swagger JSDoc block when
 *     present; else a `// GET /path — description` leading-comment line; else
 *     a file-header route-table line (the model-endpoints/cloud-link/instances
 *     convention); else the handler identifier camelCase-split into words;
 *     else the first meaningful leading comment line.
 *   - tags:    the module directory name (modules/crossmodel/coding → "coding").
 *   - security: inferred from middleware names (authenticate → user JWT via
 *     Bearer/cm_access cookie, optionalAuthenticate → anonymous allowed,
 *     authenticatePlatform → JWT or dgt_ agent token, authenticateAgent →
 *     bridge agent token) + one path heuristic: POST …/webhooks/{chatId}/fire
 *     self-authenticates with the per-chat dgw_ token inside the controller
 *     (no middleware to see).
 *
 * Deterministic: no timestamps, paths in mount order — regenerating without a
 * route change is a no-op diff. Known blind spots: routes registered outside
 * the app.ts mount graph (relay.ts is a separate process), non-literal paths,
 * and auth enforced only inside controllers (visible as description notes via
 * the /admin/ path convention, not as middleware).
 */

import fs from 'fs';
import path from 'path';
import { isProdInstance } from '../crossmodel/platform/instance-targets';
import { instancePublicUrl } from '../crossmodel/platform/instance-setup';

export interface ScannedOperation {
  method: 'get' | 'post' | 'put' | 'patch' | 'delete';
  /** OpenAPI-form full path, e.g. /api/crossmodel/chats/{id} */
  path: string;
  pathParams: string[];
  summary: string;
  /** Extra prose folded into the operation description (comment body + notes). */
  description?: string;
  tags: string[];
  /** Effective middleware names seen on the route (inherited + router + route). */
  middleware: string[];
  /** OpenAPI security requirement alternatives; [] = explicitly public. */
  security: Array<Record<string, string[]>>;
  /** Route file relative to the backend root (for diagnostics). */
  source: string;
}

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
type HttpMethod = (typeof HTTP_METHODS)[number];

/** Middleware names the scanner understands, matched as whole words. */
const KNOWN_MIDDLEWARE = [
  'authenticatePlatform',
  'optionalAuthenticate',
  'authenticateAgent',
  'authenticate',
  'rejectAgentToken',
  'rejectChild',
  'adminOnly',
  'auth',
] as const;

// ── Small source-scanning helpers ────────────────────────────────────────────

/**
 * Length-preserving comment blanking (newlines kept) so call matching never
 * sees docblock prose, while positions still align with the original source.
 * String literal contents survive (requireScope('x') / codingRun('startRun')
 * analysis needs them).
 */
function blankComments(src: string): string {
  const out = src.split('');
  let i = 0;
  let quote: string | null = null;
  while (i < out.length) {
    const c = out[i];
    const next = out[i + 1];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && next === '/') {
      while (i < out.length && out[i] !== '\n') {
        out[i] = ' ';
        i++;
      }
      continue;
    }
    if (c === '/' && next === '*') {
      out[i] = ' ';
      out[i + 1] = ' ';
      i += 2;
      while (i < out.length && !(out[i] === '*' && out[i + 1] === '/')) {
        if (out[i] !== '\n') out[i] = ' ';
        i++;
      }
      if (i < out.length) {
        out[i] = ' ';
        out[i + 1] = ' ';
        i += 2;
      }
      continue;
    }
    if (c === "'" || c === '"' || c === '`') quote = c;
    i++;
  }
  return out.join('');
}

/** Match balanced parens starting at the '(' index; string aware. */
function extractParenBlock(src: string, openIdx: number): { text: string; end: number } {
  let depth = 0;
  let i = openIdx;
  let quote: string | null = null;
  while (i < src.length) {
    const c = src[i];
    if (quote) {
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }
    if (c === '(') depth++;
    if (c === ')') {
      depth--;
      if (depth === 0) return { text: src.slice(openIdx + 1, i), end: i };
    }
    i++;
  }
  return { text: src.slice(openIdx + 1), end: src.length };
}

interface ImportEntry {
  /** Resolved absolute .ts file. */
  file: string;
  /** 'default' or the exported member name. */
  exported: string;
}

/** Map local identifier → imported route file (relative imports only). */
function parseImports(src: string, fromFile: string): Map<string, ImportEntry> {
  const map = new Map<string, ImportEntry>();
  const importRe = /import\s+([^'"]+?)\s+from\s+['"](\.[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = importRe.exec(src))) {
    const clause = m[1].trim();
    const resolved = path.resolve(path.dirname(fromFile), m[2]) + '.ts';
    // "ident", "{ a, b as c }", or "ident, { a }"
    const namedMatch = clause.match(/\{([^}]+)\}/);
    if (namedMatch) {
      for (const part of namedMatch[1].split(',')) {
        const p = part.trim();
        if (!p) continue;
        const asMatch = p.match(/^(\w+)\s+as\s+(\w+)$/);
        if (asMatch) map.set(asMatch[2], { file: resolved, exported: asMatch[1] });
        else map.set(p, { file: resolved, exported: p });
      }
    }
    const defaultIdent = clause.replace(/\{[^}]+\}/, '').replace(/,/g, '').trim();
    if (defaultIdent && /^\w+$/.test(defaultIdent)) {
      map.set(defaultIdent, { file: resolved, exported: 'default' });
    }
  }
  return map;
}

/** Whole-word occurrences of known middleware inside a call's argument text. */
function middlewareIn(argsText: string): string[] {
  const found = new Set<string>();
  for (const name of KNOWN_MIDDLEWARE) {
    if (new RegExp(`\\b${name}\\b`).test(argsText)) found.add(name);
  }
  // 'auth' is an alias of authenticate — normalize so inference sees one name.
  if (found.has('auth')) {
    found.delete('auth');
    found.add('authenticate');
  }
  const scopeRe = /\brequireScope\(\s*'([^']+)'/g;
  let sm: RegExpExecArray | null;
  while ((sm = scopeRe.exec(argsText))) found.add(`requireScope:${sm[1]}`);
  if (/\bauthorize\(\s*'ADMIN'/.test(argsText)) found.add('adminOnly');
  return [...found];
}

/** First string-literal argument of a call's argument text, if any. */
function firstStringArg(argsText: string): string | null {
  const m = argsText.trimStart().match(/^(['"`])([^'"`]+)\1/);
  return m ? m[2] : null;
}

/** Cleaned comment lines immediately above a statement (empty if none). */
function leadingCommentLines(src: string, stmtStart: number): string[] {
  let i = stmtStart;
  // Walk back over whitespace.
  while (i > 0 && /\s/.test(src[i - 1])) i--;
  if (i === 0) return [];
  const before = src.slice(0, i);
  if (before.endsWith('*/')) {
    const start = before.lastIndexOf('/*');
    if (start === -1) return [];
    return before
      .slice(start + 2, -2)
      .split('\n')
      .map((l) => l.replace(/^\s*\*\s?/, '').trim());
  }
  // Consecutive // lines directly above.
  const lines = before.split('\n');
  const out: string[] = [];
  for (let j = lines.length - 1; j >= 0; j--) {
    const t = lines[j].trim();
    if (t.startsWith('//')) out.unshift(t.replace(/^\/\/\s?/, '').trim());
    else break;
  }
  return out;
}

function camelToWords(ident: string): string {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase();
}

/** Identifiers that are never the handler name (dotted/bare-match noise). */
const HANDLER_NOISE = new Set([
  'req', 'res', 'next', 'json', 'send', 'status', 'bind', 'default',
  'query', 'body', 'params', 'headers', 'cookies', 'service', 'import',
  // middleware / wrapper helpers that appear in the argument list
  ...KNOWN_MIDDLEWARE,
  'validate', 'handle', 'h', 'requireScope', 'authorize', 'uploadMiddleware',
]);

/**
 * Handler identifier from (comment-blanked, strings-kept) argument text: the
 * last `obj.name` dotted match (controller.getPreferences → getPreferences),
 * else a factory-call argument (codingRun('startRun') → startRun), else the
 * last non-middleware bare identifier (auth, adminOnly, listUsers → listUsers).
 */
function handlerIdentifier(argsText: string): string | null {
  const re = /\b\w+\.(\w+)\s*\(?/g;
  let m: RegExpExecArray | null;
  let last: string | null = null;
  while ((m = re.exec(argsText))) {
    if (!HANDLER_NOISE.has(m[1])) last = m[1];
  }
  if (last) return last;
  const factory = argsText.match(/\b\w+\(\s*'(\w+)'\s*\)/);
  if (factory) return factory[1];
  const bare = [...argsText.matchAll(/\b(\w+)\b/g)].map((x) => x[1]).filter((x) => !HANDLER_NOISE.has(x));
  return bare.length ? bare[bare.length - 1] : null;
}

const DECORATION_RE = /^[─━═\-–—=*\s]*$/;
// `GET /path [{bodyHint}] — description` — the repo's leading-comment
// convention; the body-hint and query string are optional, as is the desc.
const ROUTE_LINE_RE = /^(GET|POST|PUT|PATCH|DELETE)\s+(\/[^\s?]*)(?:\?\S*)?(?:\s+\{[^}]*\})?\s*(?:[—–-]\s*(.*))?$/i;
// Lines that look like a design/ticket note rather than a route summary.
const DESIGN_NOTE_RE = /^([PS]\d+([-:]|$)|NOTE:|TODO|FIXME)/i;

/**
 * Join a summary with its wrapped continuation lines (the route-table and
 * leading-comment conventions wrap long descriptions). Appends lines while
 * the running text doesn't yet end a sentence; caps the result.
 */
function collectSentence(first: string, rest: string[]): { text: string; consumed: number } {
  let out = first.trim();
  let i = 0;
  while (
    i < rest.length &&
    !/[.!?]['")]*$/.test(out) &&
    rest[i] &&
    !ROUTE_LINE_RE.test(rest[i]) &&
    !DECORATION_RE.test(rest[i]) &&
    !rest[i].startsWith('@')
  ) {
    out += ' ' + rest[i].trim();
    i++;
  }
  return { text: out.length > 220 ? out.slice(0, 217).trimEnd() + '...' : out, consumed: i };
}

/**
 * File-header route-table convention (model-endpoints, cloud-link, instances):
 * a docblock listing `GET /local-path — description` lines. Returns the
 * description for the router-local path, if the file has one. The path class
 * is non-greedy + space-delimited so hyphenated paths (/cloud-link) match.
 */
function routeTableSummary(src: string, localPath: string): string | null {
  const lines = src.split('\n');
  const re = /^\s*(?:\/\/+|\*)\s*(GET|POST|PUT|PATCH|DELETE)\s+(\/\S+?)(?:\s+\{[^}]*\})?\s+[—–-]\s+(.+)$/i;
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (m && m[2] === localPath) {
      const rest: string[] = [];
      for (let j = i + 1; j < lines.length; j++) {
        const cm = lines[j].match(/^\s*(?:\/\/+|\*)\s?(.*)$/);
        if (!cm || !cm[1].trim()) break;
        rest.push(cm[1].trim());
      }
      return collectSentence(m[3], rest).text;
    }
  }
  return null;
}

/** Derive summary + leftover description lines from the available evidence. */
function summarize(opts: {
  commentLines: string[];
  argsText: string;
  fileSrc: string;
  localPath: string;
  method: string;
  fullPath: string;
}): { summary: string; commentRest: string[] } {
  const { commentLines, argsText, fileSrc, localPath, method, fullPath } = opts;
  const meaningful = commentLines.filter((l) => l && !DECORATION_RE.test(l) && !l.startsWith('@swagger'));
  // 1. @swagger JSDoc summary line.
  for (const l of meaningful) {
    const sm = l.match(/^summary:\s*(.+)$/);
    if (sm) return { summary: sm[1].trim(), commentRest: [] };
  }
  // 2. Leading `GET /path — description` line with an inline description
  //    (continuation lines joined while the sentence runs on).
  for (let i = 0; i < meaningful.length; i++) {
    const rm = meaningful[i].match(ROUTE_LINE_RE);
    if (rm && rm[3]) {
      const rest = meaningful.slice(i + 1);
      const s = collectSentence(rm[3], rest);
      return { summary: s.text, commentRest: rest.slice(s.consumed) };
    }
  }
  // 3. File-header route table.
  const table = routeTableSummary(fileSrc, localPath);
  if (table) return { summary: table, commentRest: [] };
  // 4. A bare leading route line (`GET /path`) followed by a clean prose line.
  for (let i = 0; i < meaningful.length; i++) {
    if (ROUTE_LINE_RE.test(meaningful[i]) && meaningful[i + 1] && !DESIGN_NOTE_RE.test(meaningful[i + 1])) {
      return { summary: meaningful[i + 1], commentRest: meaningful.slice(i + 2) };
    }
  }
  // 5. Handler identifier, camelCase → words.
  const handler = handlerIdentifier(argsText);
  if (handler) {
    const words = camelToWords(handler);
    return { summary: words.charAt(0).toUpperCase() + words.slice(1), commentRest: meaningful };
  }
  // 6. First meaningful comment line that isn't itself a bare path line.
  for (const l of meaningful) {
    if (!l.startsWith('/')) return { summary: l, commentRest: meaningful.filter((x) => x !== l) };
  }
  return { summary: `${method.toUpperCase()} ${fullPath}`, commentRest: [] };
}

// ── Path helpers ─────────────────────────────────────────────────────────────

function joinPaths(...parts: string[]): string {
  const joined = parts
    .filter(Boolean)
    .map((p) => p.replace(/^\/+|\/+$/g, ''))
    .filter(Boolean)
    .join('/');
  return '/' + joined;
}

/** Express path → OpenAPI path: :id → {id}, *splat → {splat} (Express 5 wildcard). */
function toOpenApiPath(p: string): { path: string; params: string[] } {
  const params: string[] = [];
  const out = p
    .split('/')
    .map((seg) => {
      if (seg.startsWith(':')) {
        params.push(seg.slice(1));
        return `{${seg.slice(1)}}`;
      }
      if (seg.startsWith('*')) {
        params.push(seg.slice(1));
        return `{${seg.slice(1)}}`;
      }
      return seg;
    })
    .join('/');
  return { path: out, params };
}

// ── Security / notes inference ───────────────────────────────────────────────

function inferSecurity(
  middleware: string[],
  method: string,
  fullPath: string
): { security: Array<Record<string, string[]>>; notes: string[] } {
  const has = (n: string) => middleware.includes(n);
  const notes: string[] = [];
  let security: Array<Record<string, string[]>>;

  // Path heuristic: the per-chat webhook fire route self-authenticates with
  // the dgw_ bearer token inside the controller (no middleware to observe).
  if (method === 'post' && /\/webhooks\/\{chatId\}\/fire$/.test(fullPath)) {
    notes.push('Self-authenticating via the per-chat `dgw_` bearer token (constant-time hash compare in the controller).');
    security = [{ webhookToken: [] }];
  } else if (has('authenticatePlatform')) {
    notes.push('Accepts a user JWT or a scoped `dgt_` agent token (scope enforced per-route).');
    security = [{ bearerAuth: [] }, { cookieAuth: [] }, { agentToken: [] }];
  } else if (has('authenticateAgent')) {
    notes.push('iMessage bridge agent bearer token (not a user JWT).');
    security = [{ agentToken: [] }];
  } else if (has('authenticate')) {
    security = [{ bearerAuth: [] }, { cookieAuth: [] }];
  } else if (has('optionalAuthenticate')) {
    notes.push('Anonymous-capable: a Bearer JWT, cm_access cookie, or ?token= is honored when present but not required (handlers may still self-check → 401).');
    security = [{ bearerAuth: [] }, { cookieAuth: [] }, {}];
  } else {
    security = [];
  }

  if (has('adminOnly')) notes.push('Requires the ADMIN role.');
  if (has('rejectChild')) notes.push('Child sub-accounts are rejected (Digby Kids).');
  if (has('rejectAgentToken')) notes.push('User JWT only — scoped agent tokens are rejected.');
  for (const mw of middleware) {
    if (mw.startsWith('requireScope:')) notes.push(`Agent-token scope required: \`${mw.slice('requireScope:'.length)}\`.`);
  }
  // Admin surface convention: /admin/* routes behind the guard are gated in
  // their controllers (role check), not by middleware the scanner can see.
  if (/\/admin(\/|\{|$)/.test(fullPath) && !has('adminOnly')) {
    notes.push('Admin-only (role enforced in the controller).');
  }
  return { security, notes };
}

// ── The scan itself ──────────────────────────────────────────────────────────

interface RouterVar {
  name: string;
  exported: string; // 'default' or the named export
}

/** All `Router()` variables in a route file, with their export binding. */
function findRouterVars(codeView: string): RouterVar[] {
  const out: RouterVar[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  const exportConstRe = /export\s+const\s+(\w+)\s*=\s*Router\(\)/g;
  while ((m = exportConstRe.exec(codeView))) {
    out.push({ name: m[1], exported: m[1] });
    seen.add(m[1]);
  }
  const constRe = /(?:^|\n)\s*const\s+(\w+)\s*=\s*Router\(\)/g;
  while ((m = constRe.exec(codeView))) {
    if (seen.has(m[1])) continue;
    seen.add(m[1]);
    // Bound as the default export? (export default router;)
    const defRe = new RegExp(`export\\s+default\\s+${m[1]}\\b`);
    out.push({ name: m[1], exported: defRe.test(codeView) ? 'default' : m[1] });
  }
  return out;
}

interface ScanCtx {
  backendRoot: string;
  operations: ScannedOperation[];
  seen: Set<string>; // dedupe "METHOD path" — first mount wins (Express order)
  visited: Set<string>; // file#export recursion guard
}

function tagForFile(file: string, backendRoot: string): string {
  const rel = path.relative(path.join(backendRoot, 'src', 'modules'), path.dirname(file));
  const segs = rel.split(path.sep).filter((s) => s && s !== '.');
  return segs.length ? segs[segs.length - 1] : 'app';
}

function scanRouteFile(
  ctx: ScanCtx,
  file: string,
  exported: string,
  prefix: string,
  inheritedMw: string[]
): void {
  const visitKey = `${file}#${exported}@${prefix}`;
  if (ctx.visited.has(visitKey)) return;
  ctx.visited.add(visitKey);
  if (!fs.existsSync(file)) return;
  const src = fs.readFileSync(file, 'utf8');
  const codeView = blankComments(src);
  const imports = parseImports(codeView, file);
  const routers = findRouterVars(codeView);
  const router = routers.find((r) => r.exported === exported) ?? routers.find((r) => r.exported === 'default');
  if (!router) return;
  const tag = tagForFile(file, ctx.backendRoot);
  const source = path.relative(ctx.backendRoot, file);

  // Every "<router>.method(" / "<router>.use(" call, in source order.
  const callRe = new RegExp(`\\b${router.name}\\.(use|${HTTP_METHODS.join('|')})\\s*\\(`, 'g');
  let m: RegExpExecArray | null;
  const routerMw: string[] = [];
  interface Pending {
    kind: 'route' | 'mount';
    method?: HttpMethod;
    path: string;
    argsText: string; // comments+strings blanked — safe for identifier analysis
    start: number;
  }
  const pending: Pending[] = [];
  while ((m = callRe.exec(codeView))) {
    const kind = m[1];
    const openIdx = codeView.indexOf('(', m.index + m[0].length - 1);
    const block = extractParenBlock(codeView, openIdx);
    const firstArg = firstStringArg(block.text);
    // block.text comes from the code view: comments are already blanked but
    // string contents survive — requireScope('chats:read') and factory calls
    // like codingRun('startRun') need them.
    const analysisText = block.text;
    if (kind === 'use') {
      if (firstArg === null) {
        // router.use(middleware...) — applies to every route in this router.
        routerMw.push(...middlewareIn(analysisText));
      } else {
        pending.push({ kind: 'mount', path: firstArg, argsText: analysisText, start: m.index });
      }
    } else {
      if (firstArg === null) continue; // non-literal path — can't document
      pending.push({ kind: 'route', method: kind as HttpMethod, path: firstArg, argsText: analysisText, start: m.index });
    }
  }

  for (const p of pending) {
    if (p.kind === 'mount') {
      // Follow router.use('/sub', subRouter): resolve the sub-router import —
      // the last identifier in the (blanked) argument text.
      const idents = [...p.argsText.matchAll(/\b(\w+)\b/g)].map((x) => x[1]);
      const candidate = idents[idents.length - 1];
      const imp = candidate ? imports.get(candidate) : undefined;
      if (imp) {
        scanRouteFile(ctx, imp.file, imp.exported, joinPaths(prefix, p.path), [...inheritedMw, ...routerMw]);
      }
      continue;
    }
    const full = joinPaths(prefix, p.path);
    const { path: oasPath, params } = toOpenApiPath(full);
    const key = `${p.method} ${oasPath}`;
    if (ctx.seen.has(key)) continue; // earlier mount wins — matches Express order
    ctx.seen.add(key);
    const middleware = [...inheritedMw, ...routerMw, ...middlewareIn(p.argsText)];
    const { summary, commentRest } = summarize({
      commentLines: leadingCommentLines(src, p.start),
      argsText: p.argsText,
      fileSrc: src,
      localPath: p.path,
      method: p.method!,
      fullPath: oasPath,
    });
    const { security, notes } = inferSecurity(middleware, p.method!, oasPath);
    const descParts = [...commentRest.filter((l) => !l.startsWith('@') && !DECORATION_RE.test(l)), ...notes];
    ctx.operations.push({
      method: p.method!,
      path: oasPath,
      pathParams: params,
      summary,
      description: descParts.length ? descParts.join('\n') : undefined,
      tags: [tag],
      middleware,
      security,
      source,
    });
  }
}

/** Scan the whole backend: app.ts mounts + every reachable route file. */
export function scanBackendRoutes(backendRoot: string): ScannedOperation[] {
  const ctx: ScanCtx = { backendRoot, operations: [], seen: new Set(), visited: new Set() };
  const appFile = path.join(backendRoot, 'src', 'app.ts');
  const src = fs.readFileSync(appFile, 'utf8');
  const codeView = blankComments(src);
  const imports = parseImports(codeView, appFile);

  // Guard tracking: a bare app.use('<prefix>', authenticate) line is the
  // single app-level guard; routers mounted at that prefix AFTER it inherit
  // `authenticate` (the app.ts ordering contract).
  const guardedPrefixes = new Set<string>();
  for (const line of codeView.split('\n')) {
    const useM = line.match(/\bapp\.use\(\s*'([^']+)'\s*,\s*(\w+)/);
    if (useM) {
      const [, prefix, firstArg] = useM;
      if (firstArg === 'authenticate') {
        guardedPrefixes.add(prefix);
        continue;
      }
      const imp = imports.get(firstArg);
      if (imp) {
        const inherited = guardedPrefixes.has(prefix) ? ['authenticate'] : [];
        scanRouteFile(ctx, imp.file, imp.exported, prefix, inherited);
      }
      continue;
    }
    // Direct routes on the app (app.get('/health', ...) etc.) — public.
    const routeM = line.match(/\bapp\.(get|post|put|patch|delete)\(\s*'([^']+)'/);
    if (routeM) {
      const method = routeM[1] as HttpMethod;
      const { path: oasPath, params } = toOpenApiPath(routeM[2]);
      const key = `${method} ${oasPath}`;
      if (ctx.seen.has(key)) continue;
      ctx.seen.add(key);
      ctx.operations.push({
        method,
        path: oasPath,
        pathParams: params,
        summary: 'Health check',
        tags: ['health'],
        middleware: [],
        security: [],
        source: 'src/app.ts',
      });
    }
  }
  return ctx.operations;
}

// ── Spec assembly ────────────────────────────────────────────────────────────

export function buildOpenApiSpec(version: string, backendRoot: string): Record<string, unknown> {
  const operations = scanBackendRoutes(backendRoot);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const op of operations) {
    paths[op.path] ??= {};
    const operation: Record<string, unknown> = {
      summary: op.summary,
      tags: op.tags,
      security: op.security,
      responses: {
        '200': { description: 'Successful response' },
        ...(op.security.length ? { '401': { description: 'Authentication required' } } : {}),
      },
    };
    if (op.description) operation.description = op.description;
    if (op.pathParams.length) {
      operation.parameters = op.pathParams.map((name) => ({
        name,
        in: 'path',
        required: true,
        schema: { type: 'string' },
      }));
    }
    paths[op.path][op.method] = operation;
  }
  const tags = [...new Set(operations.map((o) => o.tags[0]))].sort();
  return {
    openapi: '3.0.3',
    info: {
      title: 'Digby API',
      version,
      description:
        'Generated from the Express route definitions by `npm run openapi:generate` ' +
        '(backend/scripts/generate-openapi.ts). Do not hand-edit — regenerate after ' +
        'adding or changing routes; the openapi drift-guard test enforces freshness. ' +
        'Route metadata only (methods, paths, auth posture) — request/response ' +
        'schemas are intentionally not captured.',
    },
    servers: [
      // A self-hosted instance lists ITSELF first so Swagger "Try it out" hits this
      // instance, not production (self-host setup hardening 2026-10-20); production
      // and the drift-guard snapshot (prod-kind env) are unchanged.
      ...(!isProdInstance() && instancePublicUrl() ? [{ url: `${instancePublicUrl()}/api`, description: 'This instance' }] : []),
      { url: 'https://digby.ai/api', description: 'Production' },
      { url: 'http://localhost:4000/api', description: 'Local development' },
    ],
    tags: tags.map((name) => ({ name })),
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'User access JWT (short-lived) in the Authorization header.',
        },
        cookieAuth: {
          type: 'apiKey',
          in: 'cookie',
          name: 'cm_access',
          description: 'httpOnly session cookie carrying the same user access JWT (browser clients, SSE/EventSource).',
        },
        agentToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Scoped agent token (`dgt_…` platform API tokens; also bridge agent tokens where noted).',
        },
        webhookToken: {
          type: 'http',
          scheme: 'bearer',
          description: 'Per-chat inbound webhook token (`dgw_…`), minted per chat by its owner.',
        },
      },
    },
  };
}
