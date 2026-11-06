/**
 * Leg (b) PHASE 1 — the additive dual-route alias (`/api/digby` alongside
 * `/api/crossmodel`). docs/LEG_B_CROSSMODEL_RENAME_PLAN.md §3.
 *
 * These tests exist because the failure mode is SILENT. A router mounted at
 * `/api/crossmodel` but not `/api/digby` is not a compile error and not a crash:
 * it is one URL shape 404ing while the other works, discovered by an operator
 * mid-migration. So this file pins three separate things:
 *
 *   1. PARITY (behavioural): the same request under both prefixes reaches the
 *      same handler and produces an equivalent response — including the
 *      params/query/body path the handlers actually read, and the not-found
 *      shape for a path that matches neither.
 *   2. NO-DIVERGENCE (structural): `app.ts` mounts NOTHING at a literal
 *      crossmodel prefix any more — every crossmodel-family mount goes through
 *      `mountApi`, which cannot serve one prefix without the other. This is the
 *      test that fails when a future router is added the old way.
 *   3. SHARED BUDGET: both prefixes use the SAME limiter instance. Creating a
 *      per-prefix instance would silently DOUBLE every rate limit — the kind of
 *      "zero behavior change" violation that only shows up under abuse.
 *
 * The real `app.ts` is deliberately not imported: it pulls config/env (which
 * process.exit(1)s on a keyless test env) and the whole prisma/redis graph. The
 * mount seam is `mountApi` + `API_PREFIXES`, so exercising those with
 * representative routers is the honest unit under test, and (2) covers the
 * wiring in app.ts itself.
 */
import express, { Express, Router } from 'express';
import { Server } from 'http';
import { AddressInfo } from 'net';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  ALIAS_API_PREFIX,
  API_PREFIXES,
  CANONICAL_API_PREFIX,
  mountApi,
} from './api-prefixes';

/** Boot an app on port 0 and return a fetcher, mirroring the endpoint-test pattern. */
const withServer = async <T>(app: Express, fn: (base: string) => Promise<T>): Promise<T> => {
  const server: Server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const { port } = server.address() as AddressInfo;
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
};

/** A router that echoes exactly what the handler sees — the seam a prefix could corrupt. */
const echoRoutes = (): Router => {
  const r = Router();
  r.get('/things/:id', (req, res) => {
    res.json({
      id: req.params.id,
      query: req.query,
      // baseUrl is what Express BELIEVES the mount prefix is; it must differ
      // between the two (they are genuinely different mounts) while everything
      // the handlers consume stays identical.
      baseUrl: req.baseUrl,
    });
  });
  r.post('/things', (req, res) => { res.status(201).json({ received: req.body }); });
  return r;
};

describe('api-prefixes — the additive dual-route alias (leg b phase 1)', () => {
  describe('the prefix contract itself', () => {
    it('serves the canonical old prefix FIRST and adds exactly one alias', () => {
      expect(API_PREFIXES).toEqual(['/api/crossmodel', '/api/digby']);
      // Canonical first is load-bearing: mount order reads old-then-new, and any
      // future code that assumes "prefixes[0] is the one we emit" stays correct.
      expect(API_PREFIXES[0]).toBe(CANONICAL_API_PREFIX);
      expect(API_PREFIXES[1]).toBe(ALIAS_API_PREFIX);
    });

    it('keeps the old prefix byte-identical to what clients already call', () => {
      // A trailing slash, a case change or a rename here would break every
      // registered OAuth callback. This pin is the whole "zero behavior change"
      // guarantee for the canonical route.
      expect(CANONICAL_API_PREFIX).toBe('/api/crossmodel');
      expect(ALIAS_API_PREFIX).toBe('/api/digby');
    });
  });

  describe('parity — the same request answers the same way on both prefixes', () => {
    it('reaches the same handler with identical params and query', async () => {
      const app = express();
      app.use(express.json());
      mountApi(app, '', echoRoutes());

      const seen: Record<string, { id: string; query: unknown }> = {};
      await withServer(app, async (base) => {
        for (const prefix of API_PREFIXES) {
          const res = await fetch(`${base}${prefix}/things/abc-123?x=1&y=two`);
          expect(res.status).toBe(200);
          const body = (await res.json()) as { id: string; query: unknown; baseUrl: string };
          // baseUrl is the ONE legitimate difference — proof the alias is a real
          // second mount rather than the same request replayed.
          expect(body.baseUrl).toBe(prefix);
          seen[prefix] = { id: body.id, query: body.query };
        }
      });

      // Everything the handler actually consumes is identical across prefixes.
      expect(seen[CANONICAL_API_PREFIX]).toEqual(seen[ALIAS_API_PREFIX]);
      expect(seen[ALIAS_API_PREFIX].id).toBe('abc-123');
      expect(seen[ALIAS_API_PREFIX].query).toEqual({ x: '1', y: 'two' });
    });

    it('passes a request body through identically (POST)', async () => {
      const app = express();
      app.use(express.json());
      mountApi(app, '', echoRoutes());

      const results: unknown[] = [];
      await withServer(app, async (base) => {
        for (const prefix of API_PREFIXES) {
          const res = await fetch(`${base}${prefix}/things`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world', n: 3 }),
          });
          expect(res.status).toBe(201);
          results.push(((await res.json()) as { received: unknown }).received);
        }
      });

      expect(results[0]).toEqual({ hello: 'world', n: 3 });
      expect(results[0]).toEqual(results[1]);
    });

    it('mounts a SUB-path under both prefixes (the /platform, /push, /reports shape)', async () => {
      const app = express();
      app.use(express.json());
      const sub = Router();
      sub.get('/ping', (_req, res) => { res.json({ pong: true }); });
      mountApi(app, '/platform', sub);

      await withServer(app, async (base) => {
        for (const prefix of API_PREFIXES) {
          const ok = await fetch(`${base}${prefix}/platform/ping`);
          expect(ok.status).toBe(200);
          expect(await ok.json()).toEqual({ pong: true });
        }
        // The sub-path must NOT leak to the bare prefix (mountApi places it
        // under `${prefix}${subPath}`, never under `prefix` alone).
        for (const prefix of API_PREFIXES) {
          const bare = await fetch(`${base}${prefix}/ping`);
          expect(bare.status).toBe(404);
        }
      });
    });

    it('404s an unknown path identically on both prefixes', async () => {
      const app = express();
      mountApi(app, '', echoRoutes());
      app.use((_req, res) => { res.status(404).json({ error: 'nope' }); });

      await withServer(app, async (base) => {
        const bodies: unknown[] = [];
        for (const prefix of API_PREFIXES) {
          const res = await fetch(`${base}${prefix}/definitely-not-a-route`);
          expect(res.status).toBe(404);
          bodies.push(await res.json());
        }
        expect(bodies[0]).toEqual(bodies[1]);
      });
    });

    it('runs EVERY handler in the stack for both prefixes, in order (guard semantics)', async () => {
      // The single `authenticate` guard is mounted via mountApi in the middle of
      // the stack. If the alias mounted routers on only one side, a request on
      // the other side would skip the guard entirely — an auth bypass, not a
      // cosmetic 404. This pins that the whole ordered stack is duplicated.
      const order: string[] = [];
      const app = express();
      const tag = (name: string) => (_req: unknown, _res: unknown, next: () => void) => {
        order.push(name);
        next();
      };
      mountApi(app, '', tag('open'));
      mountApi(app, '', tag('guard'));
      mountApi(app, '', tag('authed'));
      app.use((_req, res) => { res.json({ ok: true }); });

      await withServer(app, async (base) => {
        for (const prefix of API_PREFIXES) {
          order.length = 0;
          const res = await fetch(`${base}${prefix}/anything`);
          expect(res.status).toBe(200);
          // Identical, complete, ordered stack per prefix.
          expect(order).toEqual(['open', 'guard', 'authed']);
        }
      });
    });
  });

  describe('shared budget — the alias must not double a rate limit', () => {
    it('hands the SAME limiter instance to both prefixes', () => {
      const app = express();
      const mounted: Array<{ path: string; handler: unknown }> = [];
      const spy = express();
      // Record what mountApi actually passes to app.use for each prefix.
      const realUse = spy.use.bind(spy);
      (spy as unknown as { use: unknown }).use = (path: string, ...handlers: unknown[]) => {
        mounted.push({ path, handler: handlers[0] });
        return realUse(path as never, ...(handlers as never[]));
      };
      const limiter = (_req: unknown, _res: unknown, next: () => void) => next();
      mountApi(spy as unknown as Express, '', limiter as never);

      const forCanonical = mounted.find((m) => m.path === CANONICAL_API_PREFIX);
      const forAlias = mounted.find((m) => m.path === ALIAS_API_PREFIX);
      expect(forCanonical).toBeDefined();
      expect(forAlias).toBeDefined();
      // Identity, not equality: a per-prefix clone would carry its own store and
      // give a caller 2x the allowance for the same budget.
      expect(forAlias!.handler).toBe(forCanonical!.handler);
    });
  });

  describe('no-divergence — app.ts cannot mount one prefix without the other', () => {
    // Scan CODE, not prose: the ordering-contract comment above the mounts
    // literally contains `app.use('/api/crossmodel', …)` as the thing NOT to
    // write, and a naive scan flags the warning itself. Strip both comment
    // forms first so the assertions below can only see executable mounts.
    const rawSource = readFileSync(join(__dirname, 'app.ts'), 'utf8');
    const source = rawSource
      .replace(/\/\*[\s\S]*?\*\//g, '')
      // Strip `//` comments only at line start or after whitespace: that covers
      // `// …` and `code(); // …` while leaving `https://…` and `'//x'` intact.
      .replace(/(^|\s)\/\/[^\n]*/g, '$1');

    it('strips comments before scanning (so the warning text is not a hit)', () => {
      expect(rawSource).toContain("app.use('/api/crossmodel', …)");
      expect(source).not.toContain("app.use('/api/crossmodel', …)");
      // …and the scan still sees real code, so it cannot pass by blanking everything.
      expect(source).toContain('mountApi(app, ');
    });

    it('contains NO raw crossmodel-family app.use mount', () => {
      const raw = source.match(/app\.use\(\s*['"]\/api\/crossmodel/g) ?? [];
      expect(raw).toEqual([]);
    });

    it('routes every mount site through mountApi', () => {
      // 8 limiters + 5 open routers + 1 /platform + 1 guard + 17 authed routers.
      const sites = source.match(/mountApi\(app,/g) ?? [];
      expect(sites.length).toBeGreaterThanOrEqual(30);
    });

    it('never mounts the alias by literal either (one list, not two)', () => {
      // A second hardcoded `/api/digby` mount would compile and pass parity for
      // that one router while silently exempting it from API_PREFIXES.
      const rawAlias = source.match(/['"]\/api\/digby/g) ?? [];
      expect(rawAlias).toEqual([]);
    });

    it('does not re-introduce a per-router path that skips the prefix list', () => {
      // app.get/post/put/delete at a crossmodel prefix would bypass mountApi.
      const direct = source.match(/app\.(get|post|put|patch|delete)\(\s*['"]\/api\/crossmodel/g) ?? [];
      expect(direct).toEqual([]);
    });
  });
});