# Security Policy

We take the security of Digby seriously. Thank you for helping keep our users
safe.

## Reporting a vulnerability

**Please do NOT open a public issue, discussion or pull request for a security
problem.**

Report privately through either channel:

1. **GitHub Security Advisories** (preferred) — go to the repository's
   **Security** tab and choose **Report a vulnerability**. This opens a private
   advisory only the maintainers can see, and gives us a place to collaborate on
   the fix and the disclosure.
2. **Email** — `security@canaquantlabs.com`. Encrypt sensitive attachments if you
   can; ask for a PGP key in your first message.

Please include, as far as you can:

- the affected component (backend, frontend, an MCP server, a client agent) and
  version or commit;
- the kind of issue (auth bypass, injection, secret exposure, SSRF, privilege
  escalation, data disclosure, dependency advisory …);
- exact reproduction steps, or a proof-of-concept;
- what an attacker gains, and any preconditions;
- whether the issue is already public anywhere.

## What to expect

| Stage | Target |
|---|---|
| Acknowledgement of your report | within 3 business days |
| Initial assessment and severity rating | within 10 business days |
| Fix for critical/high severity | as fast as the fix can be validated |
| Coordinated disclosure | by agreement, normally once a fix ships |

We will credit you in the advisory unless you ask us not to.

## Scope

**In scope** — vulnerabilities in the code in this repository: authentication and
authorisation, session handling, the agent runtime and its tool execution
boundary, the coding-session sandbox, secret storage and redaction, MCP server
implementations, the self-host Docker stack and its default configuration.

**Out of scope** — issues that require a already-compromised host; missing
security headers with no demonstrated impact; self-XSS; spam or social
engineering; denial of service from unrealistic traffic volumes; reports about
third-party services we merely integrate with (report those to the vendor, and
tell us if our default configuration makes them dangerous); and the behaviour of
a fork you have modified.

## Hardening your own deployment

A default self-host install is designed to be safe on a private network. Before
you expose Digby to the internet:

- Set strong, unique `JWT_SECRET` and `JWT_REFRESH_SECRET` (`openssl rand -hex 32`).
- Terminate TLS and set `COOKIE_SECURE=true` (see *TLS with a real domain* in
  [`docs/SELF_HOST.md`](./docs/SELF_HOST.md)).
- Set `SELFHOST_ADMIN_EMAIL` to an account you control **before** the first
  registration.
- Keep the database and Redis ports unpublished — the compose file binds them
  internally by default.
- Rotate any provider API key you have ever pasted into a chat, an issue, or a
  commit.
- Run `docker compose -f docker-compose.selfhost.yml pull && up -d` regularly to
  pick up fixes.

## Supported versions

Security fixes are issued against the latest release and the current `main`.
If you are running an older fork, rebase onto `main` to receive them.
