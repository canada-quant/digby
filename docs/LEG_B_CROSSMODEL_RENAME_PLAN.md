# Leg (b) — `crossmodel` → `digby` rename: plan and migration window

**Status: PHASE 1 SHIPPED (2026-11-06); phases 2–4 planned, not executed.**
Todo `7d41a5e1` leg (b). Surface measured 2026-11-06T14:2xZ against `origin/main`
(`7522056166c9`) and live public `canada-quant/digby`.

Phase 1 (the additive dual-serve) is implemented and tested — see §3. **Phases 2,
3 and 4 remain unapplied**, and phase 4 is the only destructive one.

The one thing this document must prevent is the obvious failure: renaming the URL
prefix without a dual-serve window, which silently breaks **every already-registered
OAuth callback** and every self-hosted instance that registered one. Phase 1 is
what makes that impossible, and it is now live in the code.

---

## 1. The number, reconciled

Three different figures were in circulation. They measure **different classes**,
which is why they disagreed:

| class | figure | how measured |
|---|---|---|
| `api/crossmodel/*` **URL-path** literals | **1,866** | `git grep -o -i '/api/crossmodel'` |
| the steer's "~1,666 literal" and the audit's "~1.7k" | ~1.7k | both name this same URL-path class |
| **full rename surface** (any case) | **12,036** occurrences / **1,807** files | `git grep -oF` for `crossmodel` (11,656), `CrossModel` (342), `CROSSMODEL` (38); union of files 1,807 |

So: renaming the API prefix is ~1.9k sites. Renaming **everything** is ~12k
occurrences across 1,807 files. The steer's ~1,666 understated the URL class
slightly and said nothing about the rest; treat 12,036 / 1,807 as the real
blast radius of a full rename.

Breakdown of the full surface:

| shape | occurrences |
|---|---|
| `crossmodel/` (path form) | 7,441 |
| `/api/crossmodel` (route prefix) | 1,866 |
| `CROSSMODEL_` (env var names) | 1,169 |
| `crossmodel\.` (module specifiers) | 821 |
| `crossmodel:` | 29 |
| files under `frontend/app/crossmodel/` | 213 |

## 2. Why this cannot be a find-and-replace

Three classes break in different ways, and only the first is a user-visible outage:

**A. Registered OAuth callbacks (the outage).** These URLs are registered *in
third-party consoles* (Google, GitHub, Slack, Asana, X, Xero, Telegram) by every
operator — Digby's own and every self-hoster's. Measured examples in the tree:

```
https://digby.ai/api/crossmodel/google/callback
https://digby.ai/api/crossmodel/slack/callback
https://digby.ai/api/crossmodel/github/...   https://digby.ai/api/crossmodel/asana/callback
https://digby.ai/api/crossmodel/x/callback   https://digby.ai/api/crossmodel/xero/callback
https://digby.ai/api/crossmodel/telegram/webhook
```

A provider redirects to whatever was registered. Rename the route and the
callback 404s — the integration appears "connected" and then fails at the exact
moment a user authorizes it. **93 OAuth-callback references** in the tree.

**B. `CROSSMODEL_` env names (1,169).** Every self-host operator's `.env` uses
them. Renaming without reading the old names too turns a working instance into an
unconfigured one on upgrade. Must be read-both / write-new.

**C. Internal module specifiers and route directories (821 + 213 files).** Large
but mechanical, and CI-verifiable — the only class where a big-bang change is
acceptable, because a miss is a compile error, not a silent production break.

## 3. The migration window — dual-serve, then migrate, then remove

Four phases. Phases 1–3 are additive and reversible; phase 4 is the only
destructive one and it happens after a full release cycle with evidence.

**Phase 1 — serve both prefixes (additive, no user action). ✅ SHIPPED 2026-11-06.**
Both prefixes resolve to the same handlers. No registration changes; every existing
callback keeps working, and a provider console can be updated at any time without a
downtime window.

What actually shipped:

- `backend/src/api-prefixes.ts` — `API_PREFIXES = ['/api/crossmodel', '/api/digby']`
  (canonical first) and `mountApi(app, subPath, …handlers)`, which mounts the same
  stack under every prefix. All 32 mount sites in `app.ts` go through it; **no**
  `app.use('/api/crossmodel', …)` remains, so a future router cannot be added to
  one prefix and forgotten on the other.
- The limiter instances are passed by reference to both prefixes, and they key on
  IP/chatId in Redis rather than on the path — so the alias shares ONE budget.
  Creating per-prefix instances would have silently doubled every rate limit.
- `GET /api/health` reports `apiPrefixes: ["/api/crossmodel","/api/digby"]`
  (non-production instances only, alongside `revision`; the prod payload is
  unchanged) so an operator can see the overlap is live.
- Guards: `backend/src/api-prefixes.test.ts` (13 tests — parity of params/query/
  body/sub-paths/404s, full ordered middleware stack per prefix incl. the single
  `authenticate` guard, shared-limiter identity, and structural no-divergence over
  `app.ts`), plus `backend/scripts/prove-api-prefix-alias.ts` for a live socket
  read (`npx tsx scripts/prove-api-prefix-alias.ts`).

**Deliberately NOT in phase 1** (still open, and nothing depends on them yet):

- Emitting the new prefix outbound (Setup checklist, OAuth-callback hint, user-facing
  docs). Every controller still builds `redirect_uri` from an env var or the
  `${frontendUrl}/api/crossmodel/…` literal, so a provider keeps being handed the URI
  that is actually registered in its console — which is what makes shipping this
  safe. Moving the emitted URL is a **phase-2** action, and it is the one that needs
  the console already updated.
- `DIGBY_*` env fallback (read new first, fall back to `CROSSMODEL_*`, warn once per
  old name). Phase 1 does not touch env names at all.

Note the ordering consequence: because nothing outbound changed, the alias is
invisible to users — it exists so operators *can* migrate, not because anything
points at it.

**Known phase-1 gap — the relay container is NOT aliased.** Three path families
are served by the `relay` service (Digby Edge), not by the Express backend, and
both its config and the self-host proxy match on the literal old prefix:

- `deploy/selfhost/Caddyfile` routes `@relayTunnel path /api/crossmodel/instances/tunnel`,
  `@relayProxy path_regexp ^/api/crossmodel/instances/[^/]+/proxy(/.*)?$` and
  `@relayMessages … chats/[^/]+/messages$` to `relay:4100` **before** the `/api/*`
  catch-all.
- `backend/src/relay/relay-core.ts` pins `TUNNEL_PATH = '/api/crossmodel/instances/tunnel'`.

So `/api/digby/instances/{tunnel,*/proxy/*,*/chats/*/messages}` does NOT work in
phase 1 — those requests fall to the backend and are not the relay. Every other
`/api/crossmodel/*` route, including the Edge pairing/management REST routes the
backend owns, IS aliased. Extending the alias across the relay is a small,
self-contained follow-up (a second Caddy matcher + a constant list in
relay-core.ts) but it cannot be proven equivalent without a live edge WS tunnel,
so it is deliberately left out rather than claimed. Operators migrating a console
should leave the Edge relay URLs on `crossmodel`.

**Phase 2 — operators migrate on their own schedule.** The Setup checklist shows
the new callback URL next to the old one and says both work. Because phase 1
served both, an operator who updates their console early, late, or never is fine.
**This is the phase that makes the window safe: nothing requires synchronisation,
so it cannot collide with active user sessions or with anyone's registration.**

**Phase 3 — internal rename.** Module specifiers, route directories, `frontend/app/`
tree. Mechanical, covered by typecheck + the existing suites. No external surface.

**Phase 4 — retire the old prefix.** Only after a full release cycle in which
phase 1 shipped everywhere, and only with: a deprecation warning in the response
headers of every `crossmodel`-prefixed hit (`Deprecation`/`Sunset`), telemetry
counting those hits per instance, and a documented floor (e.g. retire when the
count has been 0 across released versions for one cycle). If that evidence is not
available, **do not remove it** — the alias is cheap and an outage is not.

## 4. Session/token compatibility

Access and refresh tokens are opaque JWTs signed with `JWT_SECRET`; nothing in the
token encodes the URL prefix, so **no session is invalidated by the rename itself**.
Two real hazards, both handled in phase 1: cookie `path` must not be scoped to
`/api/crossmodel` (a path-scoped cookie would stop being sent — must be `/` or
re-issued), and any hardcoded absolute callback URL stored in the `oauth` state
row must be resolved from the request/prefix rather than a literal.

## 5. Coordination beyond this repo — the escalation trigger

The steer says to bring the plan back if the window needs coordination beyond this
repo. **It does, in exactly one place:** phase 3 (internal rename) and phase 1
(dual-mount) are ours alone, but **retiring the old prefix in phase 4 requires
knowing that every third-party console has been updated** — and for Digby's own
`digby.ai` instance that means Google/GitHub/Slack/Asana/X/Xero/Telegram consoles
the owner controls. So:

- Phases 1–3: **no external coordination** — proceed on approval of this plan.
- Phase 4: **owner action required** (console updates + the telemetry floor).

## 6. What "done" means

- Phase 1 merged and released; `/api/health` shows both prefixes; a real OAuth
  round-trip through the **old** and the **new** callback both succeed (this is
  testable in the anonymous install-smoke harness by hitting both paths).
- Phase 3 merged with typecheck + suites green and **0** `scripts/` references to
  the old module paths.
- Phase 4 only with the Sunset/telemetry evidence. Otherwise: not done, and that
  is the correct state to report.