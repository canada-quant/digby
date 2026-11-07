# The MCP gateway — one surface, connector options

> **Status:** current as of 2026-11-06 (todo 924725a4). This is the doc to read
> before changing anything under `mcp-gateway/`, the `*-mcp/` packages, or the
> MCP section of a compose file.

## What the product is

Digby exposes **one documented MCP surface**, configured one way, with the
connectors as **options** rather than seven products you install and upgrade
separately.

**Precisely how that surface is built — read this before quoting the doc.** It
is *not* one process that proxies all six connectors. The topology is:

- **`mcp-gateway/`** is a real HTTP gateway, but it fronts **Bright Data only**
  (`auth-proxy.js` routes to exactly two upstreams: `SUPERGATEWAY_PORT` 8001
  stateless and `SUPERGATEWAY_BROWSER_PORT` 8002 stateful — see "The two mounts"
  below). It is the only MCP service a stranger's MCP client points at.
- **The six connectors are each their own small service**, dialled **directly**
  by the backend over the compose network (`http://<name>-mcp-prod:8000/mcp`),
  each with its **own** `*_MCP_API_KEY`. Nothing proxies them.

"One surface" therefore means: one place to enable them (`--profile mcp`), one
auth convention (a shared `*_MCP_API_KEY` per connector), one doc, and one
release. It does **not** mean one socket. Saying the gateway proxies all six
would be wrong, and an earlier revision of this file did say that.

| Connector option | Env key | Package (internal) | Reached how |
|---|---|---|---|
| GitHub | `GITHUB_MCP_API_KEY` | `github-mcp/` | backend → `github-mcp-prod:8000` |
| Google (Gmail/Calendar/Drive) | `GOOGLE_MCP_API_KEY` | `google-mcp/` | backend → `google-mcp-prod:8000` |
| Slack | `SLACK_MCP_API_KEY` | `slack-mcp/` | backend → `slack-mcp-prod:8000` |
| Asana | `ASANA_MCP_API_KEY` | `asana-mcp/` | backend → `asana-mcp-prod:8000` |
| Discord | `DISCORD_MCP_API_KEY` | `discord-mcp/` | backend → `discord-mcp-prod:8000` |
| X (Twitter) | `X_MCP_API_KEY` | `x-mcp/` | backend → `x-mcp-prod:8000` |
| Web search (Bright Data) | `MCP_DIGBY_TOKEN` | `mcp-gateway/` | **public** — the gateway itself |

The `*-mcp/` directories are **implementation detail of the connector** — build
contexts inside this monorepo. They are not seven products with seven
instalments, seven READMEs and seven upgrade paths, and the public docs should
never present them that way. (They are still built and published as images so
that a compose file can pull them — see "Images" below.)

## DNS / ingress (measured 2026-11-06T20:27Z)

`mcp.digby.ai` is a CNAME onto the shared app ALB:

```
mcp.digby.ai → example-alb.ca-central-1.elb.amazonaws.com
               (16.52.248.197, 16.55.57.136)
```

Only the ALB is reachable from the internet. The connector host ports
(8200-8207) are **not** published to the world — measured directly:

```
curl http://mcp.digby.ai:8201/health  → 000   (google-mcp)
curl http://mcp.digby.ai:8206/health  → 000   (digby-mcp)
curl http://mcp.digby.ai:8200/health  → 000   (the gateway's own host port)
```

So the public path to any MCP tool goes through the gateway listener and its
key gate, never a bare connector port. The host ports exist for **intra-VPC
cross-box reach** (the FW29-F path in `scripts/ec2-ops/playbook.sh`), which is
why the six keyed connectors stay bound to all interfaces inside the VPC.

### The one exception, and why it is separate

`digby-mcp/` re-exports the **hosted** Digby platform REST API as MCP tools, so
an external agent can drive a Digby account as a specific user. It is a
different kind of thing from a connector:

- it is **vendor-specific** — it talks to Digby's own API, so it has no meaning
  on a product that must stay model- and vendor-neutral;
- it holds **no shared secret**. Every connector above compares an exact
  `*_MCP_API_KEY` and answers `401` before doing anything. `digby-mcp`
  deliberately does not (see the confused-deputy note in
  [DIGBY_MCP.md](./DIGBY_MCP.md)) — it accepts a `Bearer` and forwards it
  verbatim, letting the backend authorize.

It is therefore **out of the default surface** everywhere:

- self-host: its own `--profile mcp-platform` profile, *not* `--profile mcp`;
- prod: bound to **loopback only** (`127.0.0.1:8206`), not all interfaces.

Both are pinned by `backend/scripts/mcp-surface.test.ts`.

## Authentication model

Two layers, and the distinction is what the listener-audit test enforces:

1. **At the socket (the gate).** The gateway's `auth-proxy.js` requires a key
   and **fails closed**: its predicate is
   `if (!providedKey || providedKey !== API_KEY)` → `401`. A missing key
   rejects; it never means "no auth required". This matters because an unset
   `MCP_DIGBY_TOKEN` is the most common real-world state on a fresh install.
2. **Per connector.** Each connector independently re-checks its own
   `*_MCP_API_KEY` and also requires the provider token it acts with
   (`X-GitHub-Token`, `X-Google-Token`, …). A connector never holds a
   long-lived user credential it does not need.

The key is accepted as either `X-API-Key: <key>` or
`Authorization: Bearer <key>`.

## Public exposure: the rule

> **A connector may be published on a non-loopback interface only if it
> enforces a shared `*_MCP_API_KEY`. No shared key ⇒ loopback only.**

`backend/scripts/mcp-surface.test.ts` encodes exactly that, so a future compose
edit that adds a public binding to a keyless service fails the suite instead of
silently widening the surface.

**Do not "fix" this by binding everything to loopback.** The six keyed
connectors are reached **cross-box** in production: box C dials box A on
`8201-8205` and `8207` (see `scripts/ec2-ops/playbook.sh` — the FW29-F path and
the `10.0.0.11:<port>` overrides). Rebinding those to `127.0.0.1` breaks
coding sessions on the other boxes. The test guards this direction too.

### Out-of-band verification

Config tests cannot see a proxy, a security-group rule or a DNS change. The
denial probe speaks only HTTP, sends no credentials, and must be run against the
real deployed host:

```bash
sh scripts/mcp/probe-public-mcp-surface.sh              # defaults to mcp.digby.ai
sh scripts/mcp/probe-public-mcp-surface.sh https://mcp.example.com
```

Verdicts: `401/403` = denied (good); `000/404/405` = no listener (ok);
`2xx` = **exposed** (fail); `5xx` = **inconclusive, treated as fail** so a
broken gateway can never read as secure.

Measured 2026-11-06T19:14Z (UTC) against `https://mcp.digby.ai`:

| Path | Anonymous POST | Verdict |
|---|---|---|
| `/mcp` | `401` | denied |
| `/browser/mcp` | `401` | denied |

`GET /health` answers `200` **by design** — it is the liveness endpoint for the
container healthcheck and the ALB target group, and it exposes no tools. The
probe deliberately does not count it as a leak.

## The two mounts (why there are two supergateways)

`mcp-gateway/entrypoint.sh` runs **two** supergateways behind the one auth
proxy, and this is intentional (ticket `5f69fdc4`):

- `/mcp` → stateless. Serves search/scrape and the `x-mcp` reads. A stateless
  gateway spawns a child per POST, which is correct for one-shot tool calls.
- `/browser/mcp` → **stateful**. The interactive cloud browser keeps a browser
  in a process-level singleton, so navigate → snapshot → click must land on one
  long-lived stdio child. Stateless broke the sequence ("Page: about:blank",
  "Ref e12 not found").

They cannot be merged: a stateful gateway answers a session-less POST with
`400 No valid session ID provided`, and `x-mcp/src/brightdata-client.ts` posts
session-less to `/mcp` by design. Merging would `400` every X read.

## Images

`.digby/publish/publish-images.yml` (public tree:
`.github/workflows/publish-images.yml`) builds one image per build context so a
published compose can `pull` instead of `build`:
`-backend`, `-frontend`, `-mcp-gateway`, `-google-mcp`, `-github-mcp`, `-x-mcp`,
`-slack-mcp`, `-asana-mcp`, `-discord-mcp`, `-digby-mcp`, `-browser-service`.

Publishing an image is **not** a product claim. `digby-mcp` shipping an image
does not put it in anyone's default install — the profile (self-host) and the
loopback binding (prod) decide that, and both are tested.

## Where things live

| Path | Role |
|---|---|
| `mcp-gateway/` | the gateway: `auth-proxy.js` (key gate + routing), `entrypoint.sh` (two supergateways + supervision), `Dockerfile` |
| `github-mcp/`, `google-mcp/`, `slack-mcp/`, `asana-mcp/`, `discord-mcp/`, `x-mcp/` | connector implementations (internal) |
| `digby-mcp/` | hosted platform API re-export (own profile; loopback in prod) |
| `backend/src/modules/crossmodel/mcp-session.ts` | the backend's gateway client (sessions, re-init on `404`) |
| `backend/scripts/mcp-surface.test.ts` | the listener/auth regression suite |
| `scripts/mcp/probe-public-mcp-surface.sh` | the anonymous denial probe |

## Changing this safely

1. Edit the **source** compose (`docker-compose.selfhost.yml`) — the published
   file is generated; hand-editing it is undone by the next render.
2. Re-render and check: `node scripts/selfhost/render-published-compose.mjs`
   then `... --check` (must print `PASS`).
3. Run the surface suite: `cd backend && npx jest scripts/mcp-surface.test.ts`.
4. If you touched the deployed surface, run the denial probe and record the
   result above with a UTC timestamp.