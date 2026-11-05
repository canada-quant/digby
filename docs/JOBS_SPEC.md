# Jobs — agentic scheduled runs (supersedes Feeds)

> **Status: spec (J0).** Feeds UI is removed from the app as of this doc; the feed
> backend (`feed.service.ts`, feed cron entries in `cron.service.ts`,
> `news.service.ts`/`weather.service.ts` helpers) still runs for existing rows
> until the J4 migration below. Do not build new surface on `feedsApi` — build Jobs.
>
> **2026-08-31:** J1–J4 remain unimplemented; `feed.service.ts`/`UserFeed`
> still run pending J4.

## Vision

A **Job** is any unit of agentic work Digby runs for the user on a schedule or on
demand — not just periodic content digests (Feeds). "Every weekday at 8am,
summarize my unread email into my Morning chat." "Every Sunday night, open a PR
that bumps deps and runs the test suite." "In 20 minutes, check whether the deploy
went green and tell me." The same machinery that powers the agent's internal
`schedule_message` / `schedule_self` tools becomes a first-class, user-visible
product surface — consistent with the platform-unification principle that anything
the UI can do, the models can do with the user's permissions.

Feeds was the narrow precursor: one hard-coded job template (topic → periodic
digest → chat). Jobs generalizes it: a feed is simply a Job whose prompt asks for
a digest.

## Foundation already shipped (P0–P6, main @ feb1a87)

- **Durable scheduled runs**: `CodingSchedule`/schedules infra + the worker's
  durable cron runner — a schedule row fires a full agent run against a chat,
  survives deploys/restarts, min interval 15 min, auto-expiry, maxRuns.
- **Platform REST**: `POST/GET/DELETE /api/crossmodel/platform/schedules` with
  scoped agent tokens (`schedules:write`).
- **Agent tools**: `schedule_message`, `list_schedules`, `cancel_schedule` are
  already in the chat orchestrator tool profile — the agent can already create
  ad-hoc schedules conversationally; Jobs makes them named, visible, manageable.
- **Unified sessions**: a job run IS an agent run in a chat — transcript, stream
  endpoint, and visibility come free (users watch job runs live like any run).

## Product surface

1. **Natural-language creation (primary)** — the chat agent creates Jobs via a
   `create_job` tool: name, prompt, cadence (interval or cron + timezone), target
   chat (existing or new), enabled. The agent confirms details back in chat.
2. **Jobs UI (management)** — replaces the removed Feeds sidebar section:
   - List: name, cadence humanized ("Every weekday · 8:00 AM"), next run, last
     run status (ok/failed), enabled toggle.
   - Row actions: Run now, Pause/Resume, Edit (prompt/cadence), Delete.
   - Row tap → the job's chat (runs are ordinary chats; full transcripts).
   - "New Job" composer sheet as an alternative to NL creation (prompt, schedule
     picker, target chat picker) — same API the agent tools call.
3. **Run history** — per job: last N runs with status/duration/link to the run
   in the chat. Backed by the existing agent-run records (no new event store).
4. **Failure posture** — N consecutive failures auto-pauses the job and posts a
   note into its chat (never silently dies; never spams).

## Data model

Extend the existing schedule row rather than fork a parallel system. Add to the
schedules table (Prisma):

| column | type | notes |
|---|---|---|
| `name` | `String?` | NULL = legacy ad-hoc schedule (pre-Jobs); named rows are "Jobs" |
| `kind` | `String` | `agent` (default) — room for future `feed-migration` marker during J4 |
| `cronExpr` | `String?` | when set, takes precedence over `intervalMinutes` |
| `timezone` | `String?` | IANA name; defaults to the user's stored tz |
| `enabled` | `Boolean` | pause/resume without deleting |
| `consecFailures` | `Int` | auto-pause threshold (3) |
| `template` | `String?` | `digest`, `deps-pr`, … optional starter presets |

Migration: additive columns only; existing rows keep working unchanged.

## API

User-facing (authed): `GET/POST /api/crossmodel/jobs`, `PATCH/DELETE
/api/crossmodel/jobs/:id`, `POST /api/crossmodel/jobs/:id/run`,
`GET /api/crossmodel/jobs/:id/runs`.

Platform/agent surface (Pillar-1 consistent): the same handlers behind
`/api/crossmodel/platform/jobs/*` with `schedules:write` scope, plus agent tools
`create_job`, `list_jobs`, `update_job`, `run_job`, `delete_job` in the chat
orchestrator profile (consequential: `create_job`/`run_job` require a
confirmation user-turn, same gate as `start_coding_session`).

## Phases

| Phase | Scope | Effort |
|---|---|---|
| **J1** | Schema columns + jobs CRUD routes (thin rename/reuse of schedules service) + worker honors `cronExpr`/`enabled`/`consecFailures` | ~1 day |
| **J2** | Jobs sidebar section (list/toggle/run-now/delete) + New Job sheet + run history drawer | ~1 day |
| **J3** | Agent tools + NL creation polish ("every weekday at 8" → cron + tz confirm) | ~0.5 day |
| **J4** | Feeds migration: one-off script converts each feed row into a Job (`template: 'digest'`, prompt built from the feed topic, same interval, same chat); then delete `feed.service.ts`, feed cron entries, `feedsApi`, `UserFeed`, and the `📡 **Feed Update**` scheduler path | ~1 day |

## Quotas & safety

- Per-user cap (e.g. 25 enabled jobs); min interval 15 min (matches schedules).
- Jobs run with the user's permissions and are audited in `Activity` (create,
  pause, run-now, delete, auto-pause).
- A job's chat is owned by the job: deleting the job archives its chat (keep
  transcripts; never hard-delete user-visible history without an explicit
  "also delete chat" confirm).
