# Contributing to Digby

Thanks for your interest. This guide covers the mechanics so your contribution
lands quickly.

## Before you start

- **Security issues** — never a public issue. Follow [`SECURITY.md`](./SECURITY.md).
- **Large changes** — open an issue describing the design first. It is cheaper to
  agree on an approach than to rewrite a pull request.
- **Small fixes** — typos, docs, obvious bugs — just send the pull request.

By participating you agree to the [Contributor Covenant](./CODE_OF_CONDUCT.md).

## Development setup

**Backend** (`backend/`, Express + Prisma + Jest):

```bash
cd backend
npm ci
npx prisma generate
npm run dev          # tsx watch src/server.ts
npm test             # jest
npx tsc --noEmit     # typecheck
npm run lint         # eslint
```

**Frontend** (`frontend/`, Next.js + Vitest):

```bash
cd frontend
npm ci
npm run dev          # next dev
npm test             # vitest run
npm run lint         # eslint .
npm run build        # next build
```

**Full stack** — the fastest way to exercise real behaviour end to end:

```bash
cp selfhost.env.example .env   # set JWT secrets + one provider key
docker compose -f docker-compose.selfhost.yml up -d --build
# http://localhost:8080
```

## What "done" means here

A change is ready when all of the following hold:

1. **It is tested.** New behaviour gets a test that fails without your change.
   Bug fixes get a regression test that pins the exact defect. This repository
   has a strong habit of testing the *real* seam rather than a mock of it — follow
   that.
2. **The suites pass.** `backend` jest, `frontend` vitest, and `tsc --noEmit` for
   both. CI runs these; a red run is not reviewable.
3. **Lint is clean.**
4. **Docs move with the code.** If you change behaviour, an API surface, a CLI, a
   configuration variable, or a setup step, update the document that describes it
   in the same commit (`docs/`, `selfhost.env.example`, `README.md`).
5. **No secrets, ever** — see below.

## Never commit secrets

This is a public repository. Before you push:

- No API keys, tokens, passwords, private keys or connection strings with real
  credentials — not in code, not in tests, not in fixtures, not in docs, not in
  screenshots.
- Use obvious placeholders in tests (`sk-AAAAAAAA…`, `hunter2`) or generate
  throwaway values at runtime.
- Configuration comes from the environment. Add a new variable to
  `selfhost.env.example` with a safe example value and a comment.
- If you *did* commit a credential, **rotate it first**, then tell the
  maintainers. Removing it from a later commit does not remove it from history.

## Adding a database change

`backend/prisma/schema.prisma` is the source of truth. Create a migration with

```bash
cd backend
npx prisma migrate dev --name describe_the_change
```

Commit the schema change **and** the generated migration. Migrations are applied
automatically by the self-host `migrate` service on `up`.

## Adding an MCP integration

Each integration server is its own top-level directory (`<name>-mcp/`) with its
own `package.json`. Follow the shape of an existing server, add it to the `mcp`
profile in `docker-compose.selfhost.yml`, and document its environment variables
in `selfhost.env.example` and `docs/DIGBY_MCP.md`.

## Commit messages and pull requests

- One logical change per pull request.
- Write the subject in the imperative mood: *"fix session replay on reconnect"*,
  not *"fixed"* or *"fixes"*.
- In the body, say **what was wrong**, **what you changed**, and **how you
  verified it**. Paste the command you ran and its result.
- Link the issue it closes.

## Licensing of contributions

Digby is dual-licensed (AGPL-3.0-or-later plus a commercial licence — see
[`LICENSE-COMMERCIAL.md`](./LICENSE-COMMERCIAL.md)). By submitting a
contribution you agree that Canada Quant Labs Inc. may license it under both.
If you contribute on behalf of an employer, you confirm you have authority to
grant that.

## Code of conduct

Participation is governed by the [Contributor Covenant](./CODE_OF_CONDUCT.md).
Report unacceptable behaviour to `conduct@canaquantlabs.com`.
