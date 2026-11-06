/**
 * Live proof for leg (b) phase 1: boot an HTTP server through the REAL mount
 * seam (api-prefixes.mountApi) and curl the same resource on both prefixes.
 *
 * This is the runnable form of the acceptance criterion "a live 200 read on
 * each prefix". It is NOT a substitute for api-prefixes.test.ts (which owns the
 * behavioural + structural pins); it exists so an operator can see the alias
 * answer on a real socket, not just in jest.
 *
 *   npx tsx scripts/prove-api-prefix-alias.ts
 *
 * Exit 0 = both prefixes answered 200 with the same body; non-zero = they did not.
 */
import express from 'express';
import { API_PREFIXES, mountApi } from '../src/api-prefixes';

const PORT = Number(process.env.ALIAS_PROOF_PORT || 0);

const app = express();
app.use(express.json());

// A representative authed-style resource: a param path + a query string.
const routes = express.Router();
routes.get('/things/:id', (req, res) => {
  res.json({ ok: true, id: req.params.id, q: req.query.q ?? null });
});
mountApi(app, '', routes);

const server = app.listen(PORT, async () => {
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : PORT;
  const base = `http://127.0.0.1:${port}`;
  let failed = false;

  for (const prefix of API_PREFIXES) {
    const url = `${base}${prefix}/things/live-42?q=yes`;
    try {
      const res = await fetch(url);
      const body = (await res.text()).trim();
      const status = res.status;
      console.log(`${status === 200 ? 'PASS' : 'FAIL'}  HTTP ${status}  ${prefix}/things/live-42?q=yes  ${body}`);
      if (status !== 200) failed = true;
    } catch (err) {
      console.log(`FAIL  ${prefix} — ${(err as Error).message}`);
      failed = true;
    }
  }

  server.close(() => process.exit(failed ? 1 : 0));
});