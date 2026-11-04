import express from 'express';
import type { Server } from 'http';
import { z } from 'zod';
import { validate } from './validate';

// Express 5 made req.query a prototype getter that re-parses on every access.
// The validate middleware must shadow it with an instance data property holding
// the transformed values — otherwise zod transforms silently vanish: handlers
// re-read req.query and get a fresh parse of the raw string (the Express 4
// Object.assign(req.query, parsed) pattern wrote into a throwaway object).
describe('validate middleware (Express 5 req.query getter)', () => {
  const schema = z.object({
    query: z.object({
      limit: z
        .enum(['10', '25'])
        .optional()
        .transform((v) => (v === undefined ? undefined : Number(v))),
    }),
  });

  function buildApp(onQuery: (q: unknown) => void) {
    const app = express();
    app.get('/t', validate(schema), (req, res) => {
      onQuery(req.query);
      res.json({ ok: true });
    });
    app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
      res.status(400).json({ error: err.message });
    });
    return app;
  }

  async function call(app: express.Express, path: string): Promise<{ status: number }> {
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    try {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const r = await fetch(`http://127.0.0.1:${port}${path}`);
      await r.json();
      return { status: r.status };
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }

  it('handler receives the zod-transformed query values, not a fresh re-parse', async () => {
    let seen: Record<string, unknown> = {};
    const app = buildApp((q) => {
      seen = q as Record<string, unknown>;
    });
    const r = await call(app, '/t?limit=25&extra=abc');
    expect(r.status).toBe(200);
    expect(seen.limit).toBe(25); // transformed number, not the raw string '25'
    expect(seen.extra).toBe('abc'); // undeclared keys survive the merge
  });
});
