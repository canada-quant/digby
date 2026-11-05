# Email as Digby (`send_email_as_digby`)

> Framework capability (ticket 54f237bf): any agent — chat or coding seat,
> human-attended or machine-triggered — can send an email **as Digby** from its
> own address **digby@digby.ai**. "Send me an email when X happens", "email me a
> daily digest of Y" are one tool call, including from a scheduled run.

## What it is (and is NOT)

| | `send_email_as_digby` | `gmail_send_email` |
|---|---|---|
| Sends from | **digby@digby.ai** (Digby's own identity) | the **user's** connected Gmail |
| Transport | SMTP (`nodemailer`, Gmail workspace relay) | Google MCP (user's OAuth token) |
| Machine-triggered runs | **YES** (no user-turn gate — a schedule/hook/webhook firing can send) | NO (human-attended turn only) |
| Recipients | any address (one `to` + optional one `cc` per call) | any address |
| Rate cap | 30/hour **per instance** (in-memory sliding window) | none extra |
| Telemetry | `loop_metrics` kind `digby_email_sent` (recipient PREFIX only — see below) | — |

## Env vars (all optional — absent credentials = `not configured`, never a crash)

```bash
DIGBY_SMTP_HOST=smtp.gmail.com   # default smtp.gmail.com
DIGBY_SMTP_PORT=587              # default 587 (STARTTLS); 465 implies implicit TLS
DIGBY_SMTP_USER=digby@digby.ai   # the mailbox Digby authenticates as
DIGBY_SMTP_PASS=                 # Gmail workspace APP PASSWORD (owner-provisioned)
DIGBY_SMTP_FROM=digby@digby.ai   # default digby@digby.ai — the From: address
```

Without `DIGBY_SMTP_USER` **and** `DIGBY_SMTP_PASS` the service reports
`notConfigured`; the tool returns an actionable message naming the env vars, and
the model is told to relay that honestly (never claim a send that didn't happen).

## Provisioning (OWNER step — the Gmail workspace app password)

1. In the Google Workspace admin console, ensure 2-Step Verification is enforced
   (or at least enabled) for the `digby@digby.ai` account.
2. Sign in as `digby@digby.ai` → **My Account → Security → 2-Step Verification →
   App passwords** (https://myaccount.google.com/apppasswords).
3. Create an app password (label it e.g. "digby-smtp"), copy the 16-character
   password.
4. Set it as the `DIGBY_SMTP_PASS` secret (GitHub Actions secret for the prod
   fleet; plain env var for self-hosted). **Never commit it** — env only.
   The full prod wiring (owner step once, then automatic on every deploy):
   set the GitHub secrets `DIGBY_SMTP_USER` + `DIGBY_SMTP_PASS` (and optionally
   `DIGBY_SMTP_HOST` / `DIGBY_SMTP_PORT` / `DIGBY_SMTP_FROM` — defaults apply
   when unset, and empty values are dropped by the coding-box stage). The
   deploy wave templates them into the web-fleet `.env` (A/B) and the coding
   box's curated `/opt/crossmodel-local/env-secrets.env` (C — its `.env` is
   never rewritten from secrets, so a key absent from that curated list never
   reaches the worker). Pin: `scripts/deploy/smtp-env-secrets.f670b63b.test.sh`.
5. Optional: restrict the app password's usage to SMTP in the Workspace admin
   console (Admin → Apps → Google Workspace → Gmail → Settings for Gmail →
   "Allow per-user app passwords"; Gmail SMTP relay stays on by default).

Verify with a one-off probe after deploying:

```bash
docker exec <backend-container> node -e \
  "require('./dist/modules/crossmodel/email/digby-email.service.js')" \
  # or simply ask Digby (in chat): "send me a test email as digby"
```

## Rate limit

`DIGBY_EMAIL_HOURLY_CAP` is not configurable — the cap is **30 sends/hour per
backend instance** (in-memory sliding window, `email/digby-email.service.ts`).
A runaway agent loop cannot blast people: the 31st send in an hour fails with a
clean `rate_limited` error the model is told to relay and not retry. The cap
resets as timestamps slide out of the window.

## Privacy in logs/telemetry

- The SMTP password is **never** logged or included in metrics.
- Email **bodies are never** logged or recorded.
- `loop_metrics` rows (kind `digby_email_sent`) record `outcome`
  (`sent` | `send_failed` | `rate_limited` | `not_configured`), the recipient as
  a **prefix only** (local part capped at 12 chars + domain — e.g.
  `codouble…@gmail.com` shape, mirroring `gmail_send_email`'s
  recipient-privacy posture), message id, and subject/body CHARACTER COUNTS.
- Winston logs carry the same prefix-only recipient + counts.

## Agent usage examples

**"Email me when the deploy finishes"** (live turn):
```
schedule_message → prompt: "check the deploy status, then send_email_as_digby
to=me@example.com subject='Deploy finished' text=<status summary>"
```

**"Email me a daily digest of AI news"** (topic feeds were retired 2026-10-20 —
a scheduled message on a real chat is the replacement):
```
schedule_message → prompt: "research the latest AI news and email me a concise
digest with sources" → each firing calls send_email_as_digby with the digest
as the text body
```

**Direct (any run, including machine-triggered):**
```json
{ "to": "owner@example.com", "subject": "Nightly report", "text": "…" }
```

The tool is deliberately **not** user-turn-gated (that is the whole point of
machine capability), but its description carries the anti-abuse rule: use it for
notifications/digests the owner asked for — **never for mass/bulk sends**
(mailing lists, campaigns, one-email-per-recipient blasts). One recipient per
call, 30/hour per instance.

## Where the code lives

- `backend/src/modules/crossmodel/email/digby-email.service.ts` — transport,
  validation, rate limit, telemetry. Never throws to the caller.
- `backend/src/modules/crossmodel/platform/account-tools.ts` — the
  `send_email_as_digby` tool (schema + handler; registered in the
  non-consequential mutating tier alongside `notify_user`, so it reaches both
  agent surfaces — coding `CODING_TOOL_SCHEMA` and the chat profile — with no
  extra wiring).
- `backend/src/modules/crossmodel/platform/platform-tool-names.ts` — the name
  registration (`PLATFORM_MUTATING_TOOLS`).
- `backend/src/modules/crossmodel/chat-agent/capability-doctrine.ts` — the
  trigger → tool row ("email me when … → send_email_as_digby").

## Ops wiring (self-hosted / prod)

The prod fleet reads the env from `.github/workflows/deploy.yml` (the `Update
.env on EC2` step writes `DIGBY_SMTP_*` from GitHub secrets
`DIGBY_SMTP_USER`/`DIGBY_SMTP_PASS`); `docker-compose.prod.yml` /
`docker-compose.app.yml` pass them through with `${VAR:-}` defaults;
`selfhost.env.example` documents the block. Add the two secrets in GitHub →
Settings → Secrets before the next deploy to activate.
