/**
 * Digby Code — live app preview.
 *
 * Renders whatever a session's dev server is serving, inside a sidebar iframe.
 * The backend can't route to the session container over the network (it runs on
 * the default bridge with no published ports), but it CAN `docker exec` into it —
 * so we proxy by running `curl http://localhost:<port>` INSIDE the session and
 * streaming the bytes back. Zero networking changes. The in-process fallback
 * runs ONLY with container mode off; in container mode a missing session
 * container answers 503 (fail closed, 2026-10-20 — hostExecFallbackAllowed).
 *
 * Auth: iframes can't set headers, so the top-level request carries ?token= (like
 * the SSE stream). We then set a path-scoped cookie so the iframe's sub-resource
 * requests (which don't carry the query) authenticate too. HTML is rewritten
 * (<base> + root-absolute href/src) so assets resolve back through this proxy.
 *
 * Best-effort by design: great for SSR / plain-HTML / relative-asset apps; a
 * dev server that hard-codes absolute asset URLs in JS or needs HMR websockets
 * won't fully work here (that wants the deferred subdomain-proxy). Never a
 * security hole: only the owner's own session, path-injection-sanitised.
 */

import { Request, Response } from 'express';
import { execFile } from 'child_process';
import { promisify } from 'util';
import prisma from '../../../config/database';
import logger from '../../../utils/logger';
import { ensureSessionContainer, execInContainer, hostExecFallbackAllowed } from './container.service';
import { worktreePath } from './workspace.service';
import { cookieSecure } from '../../auth/auth-cookie';

const execFileAsync = promisify(execFile);
const PREVIEW_TIMEOUT_MS = 25_000;

/**
 * Optional DEDICATED preview origin (e.g. "preview.digby.ai"). When set, previews
 * are served cross-origin from the main app, so a previewed (possibly third-party)
 * dev server's JS runs on a SEPARATE origin and structurally cannot touch the app's
 * localStorage/cookies — which lets us safely re-enable allow-same-origin for full
 * SPA support (absolute asset URLs, localStorage). Requires nginx to route this host
 * to the same backend preview path + a wildcard/host TLS cert (see docs/DIGBY_CODE.md).
 * Unset (default) → same-origin preview, which is already token-safe because the
 * iframe sandbox omits allow-same-origin.
 */
const PREVIEW_HOST = (process.env.CODING_PREVIEW_HOST || '').trim();
/** The app origin(s) allowed to frame a preview (frame-ancestors CSP). */
const APP_ORIGIN = (process.env.FRONTEND_URL || 'https://digby.ai').split(',')[0].trim();

/**
 * Ports the preview proxy must NEVER curl. In the in-process fallback (container
 * mode off — the default) `curl http://localhost:<port>` runs in the BACKEND, so
 * an unguarded port lets an authenticated user reach loopback infra services
 * (the backend's own API, postgres, redis, adminer, the MCP containers). Dev
 * servers live well above these. The backend's own PORT is added dynamically.
 */
const BLOCKED_PREVIEW_PORTS = new Set<number>([
  22, 25, 53, 111, 445,
  2375, 2376,            // docker daemon
  4000, 4001, 4002,      // backend API (blue/green)
  5432, 9384,            // postgres
  6379, 7856,            // redis
  8200, 8201, 8202, 8203, 8204, 8205, // MCP gateway + servers
  9521,                  // adminer
]);
function previewPortBlocked(port: number): boolean {
  if (BLOCKED_PREVIEW_PORTS.has(port)) return true;
  const own = Number(process.env.PORT);
  return Number.isInteger(own) && port === own;
}

/** Cookie path so the browser sends the preview cookie on every sub-resource of THIS session's preview. */
function cookiePath(id: string): string {
  return `/api/crossmodel/coding/sessions/${id}/preview`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

/** The session container is unavailable and container mode refuses host bash. */
export class PreviewIsolationUnavailableError extends Error {
  constructor() { super('preview: session container unavailable (container mode refuses host execution)'); }
}

/** Run a command inside the session (container if available; in-process bash
 *  ONLY when container mode is off — fail closed otherwise, 2026-10-20). */
async function execInSession(sessionId: string, worktree: string, cmd: string): Promise<string> {
  const useContainer = await ensureSessionContainer(sessionId).catch(() => false);
  if (useContainer) {
    const { stdout } = await execInContainer(sessionId, cmd, worktree, PREVIEW_TIMEOUT_MS);
    return stdout;
  }
  if (!hostExecFallbackAllowed()) throw new PreviewIsolationUnavailableError();
  const { stdout } = await execFileAsync('bash', ['-lc', cmd], {
    cwd: worktree, timeout: PREVIEW_TIMEOUT_MS, maxBuffer: 24 * 1024 * 1024,
    env: { PATH: process.env.PATH, HOME: worktree },
  }).catch((e: any) => ({ stdout: e.stdout?.toString() || '' }));
  return stdout.toString();
}

class CodingPreviewController {
  /** Query-token/cookie fallback: copy a preview cookie into ?token so optionalAuthenticate sees it. */
  cookieToQuery(req: Request, _res: Response, next: () => void) {
    if (!req.query.token) {
      const c = readCookie(req, 'dcp');
      if (c) {
        // Express 5: req.query is a re-parsing prototype getter — a plain
        // property write lands on a throwaway object and is silently lost.
        // Shadow the getter with an instance data property holding the merge
        // (same pattern as middleware/validate.ts).
        Object.defineProperty(req, 'query', {
          value: { ...(req.query as Record<string, unknown>), token: c },
          writable: true,
          enumerable: true,
          configurable: true,
        });
      }
    }
    next();
  }

  async preview(req: Request, res: Response) {
    const userId = req.user?.id;
    if (!userId) return res.status(401).send('Sign in to preview.');
    if ((req.user as any)?.isChild) return res.status(403).send('Not available.');

    const { id } = req.params;
    const port = Number(req.params.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return res.status(400).send('Invalid port.');
    if (previewPortBlocked(port)) return res.status(400).send('That port is reserved and cannot be previewed.');

    const { getSessionForUser } = await import('./coding-data.service');
    const session = await getSessionForUser(id, userId, 'owner');
    if (!session || !session.worktreePath) return res.status(404).send('Session not ready.');

    // Upstream path = the wildcard tail + the query (minus token), single-quote-safe.
    // Express 5 / path-to-regexp v8: the named wildcard /*splat arrives as a
    // string[] of path segments in req.params.splat (Express 4 put the raw tail
    // in params[0] — kept as a fallback for tests mocking the old shape).
    const splatParam: unknown = (req.params as Record<string, unknown>).splat ?? req.params[0];
    const tailRaw = Array.isArray(splatParam) ? splatParam.join('/') : String(splatParam || '');
    const tail = tailRaw.replace(/'/g, '%27');
    const qs = Object.entries(req.query)
      .filter(([k]) => k !== 'token')
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    const upstream = `/${tail}${qs ? `?${qs}` : ''}`.replace(/'/g, '%27').replace(/\s/g, '');

    const wt = worktreePath(session.id);
    // curl → status + content-type on line 1, base64 body after (binary-safe).
    const cmd =
      `curl -s -m 20 --max-filesize 8000000 -o /tmp/dcp_$$ ` +
      `-w '%{http_code} %{content_type}' 'http://localhost:${port}${upstream}' 2>/dev/null; ` +
      `echo; base64 -w0 /tmp/dcp_$$ 2>/dev/null; rm -f /tmp/dcp_$$`;

    let out = '';
    try { out = await execInSession(session.id, wt, cmd); }
    catch (e: any) {
      if (e instanceof PreviewIsolationUnavailableError) {
        // Fail closed: a clear 503 page, never a curl from this host.
        logger.info(`coding preview refused for session ${session.id}: ${e.message}`);
        this.setFrameHeaders(res);
        res.status(503).type('html');
        return res.send(isolationUnavailableHtml());
      }
      logger.warn(`coding preview exec failed: ${e.message}`);
    }

    const nl = out.indexOf('\n');
    const head = (nl >= 0 ? out.slice(0, nl) : out).trim();
    const b64 = nl >= 0 ? out.slice(nl + 1).trim() : '';
    const code = parseInt(head.split(' ')[0], 10) || 0;
    const contentType = head.split(' ').slice(1).join(' ').trim() || 'application/octet-stream';

    // If we authed via ?token, drop a path-scoped cookie so sub-resources authenticate.
    // On a dedicated cross-origin preview host the frame is same-SITE but cross-ORIGIN,
    // so the cookie needs SameSite=None to ride embedded sub-resource requests.
    // secure follows cookieSecure() — a plain-http self-hosted instance (no TLS)
    // must not emit Secure cookies the browser would refuse to store. Note:
    // SameSite=None (PREVIEW_HOST mode) still requires Secure, i.e. real TLS.
    if (req.query.token) {
      res.cookie('dcp', String(req.query.token), {
        path: cookiePath(id), httpOnly: true, secure: cookieSecure(), maxAge: 3600_000,
        sameSite: PREVIEW_HOST ? 'none' : 'lax',
      });
    }

    if (!code) {
      this.setFrameHeaders(res);
      res.status(200).type('html');
      return res.send(placeholderHtml(port, session.id));
    }

    let body = Buffer.from(b64, 'base64');
    if (/text\/html/i.test(contentType)) {
      body = Buffer.from(rewriteHtml(body.toString('utf8'), id, port));
    }
    this.setFrameHeaders(res);
    res.status(code);
    res.setHeader('Content-Type', contentType);
    return res.send(body);
  }

  /**
   * Constrain who may frame a preview. Same-origin (default): only our own app,
   * via `frame-ancestors 'self'` (+ legacy X-Frame-Options). Dedicated preview
   * host: the app is a DIFFERENT origin, so X-Frame-Options SAMEORIGIN would block
   * it — use `frame-ancestors <app origin>` instead and omit X-Frame-Options.
   */
  private setFrameHeaders(res: Response) {
    if (PREVIEW_HOST) {
      res.setHeader('Content-Security-Policy', `frame-ancestors ${APP_ORIGIN}`);
    } else {
      res.setHeader('Content-Security-Policy', "frame-ancestors 'self'");
      res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    }
  }
}

const PREVIEW_BASE = (id: string, port: number) => `/api/crossmodel/coding/sessions/${id}/preview/${port}/`;

/** Rewrite root-absolute href/src/action, THEN inject <base> for relative URLs. */
function rewriteHtml(html: string, id: string, port: number): string {
  const base = PREVIEW_BASE(id, port);
  // 1) Root-absolute asset/link/form URLs → proxy-prefixed. Done FIRST so the
  //    <base> tag we add next isn't itself rewritten (best-effort; JS-built URLs
  //    are not rewritten — those need the deferred subdomain proxy).
  let out = html.replace(/(\s(?:href|src|action)=)(["'])\/(?!\/)/gi, `$1$2${base}`);
  // 2) <base> so RELATIVE URLs resolve back through the proxy.
  const baseTag = `<base href="${base}">`;
  out = /<head[^>]*>/i.test(out)
    ? out.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`)
    : `${baseTag}${out}`;
  return out;
}

function isolationUnavailableHtml(): string {
  return `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:24px;color:#666">
  <p>Preview is unavailable right now: this session's isolated container is not reachable from this server.</p>
  <p>Digby never runs a session's commands outside its container. Try again in a minute, or ask the agent to check the dev server from its own shell.</p>
  </body>`;
}

function placeholderHtml(port: number, id: string): string {
  return `<!doctype html><meta charset=utf-8><body style="font:14px system-ui;padding:24px;color:#666">
  <p>No server responding on <b>localhost:${port}</b> in this session yet.</p>
  <p>Start your dev server (e.g. via the agent's <code>start_background_process</code>), then reload.</p>
  <p style="color:#999;font-size:12px">Preview is best-effort: SSR / plain-HTML apps render well; some SPA dev servers with absolute asset paths or live-reload may not fully load here.</p>
  </body>`;
}

export default new CodingPreviewController();
