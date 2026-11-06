# Leg (b) — `crossmodel` → `digby` rename: plan and migration window

**Status: PLANNED, NOT EXECUTED.** Todo `7d41a5e1` leg (b). Measured 2026-11-06T14:2xZ
against `origin/main` (`7522056166c9`) and live public `canada-quant/digby`.

This is the "plan to bring to the supervisor" the steer asked for before execution.
Nothing here has been applied. The one thing this document must prevent is the
obvious failure: renaming the URL prefix without a dual-serve window, which
silently breaks **every already-registered OAuth callback** and every self-hosted
instance that registered one.

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

**Phase 1 — serve both prefixes (additive, no user action).**
Mount the whole `/api/crossmodel` router a second time at `/api/digby`, so both
resolve to the same handlers. No registration changes; every existing callback
keeps working, and a provider console can be updated at any time without a
downtime window. Outbound: emit the **new** prefix in every URL we hand a user
(the Setup checklist, the OAuth-callback hint, docs). Env: read `DIGBY_*` first,
fall back to `CROSSMODEL_*`, warn once per old name. `GET /api/health` reports
`apiPrefixes: ["digby","crossmodel"]` so an operator can see the overlap is live.

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