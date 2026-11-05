# Credential audit — `canada-quant/digby` full history (2026-11-04)

**Purpose.** The publish gate for the open-source flip (`todo af1a6bd3`) is: **zero
live-class credentials anywhere in `canada-quant/digby`'s full history**. This is
the evidence record for that gate, produced by the Crossmodel Supervisor lane
(`todo c5d8c066`) under goal `2ee2aa2d` (open-source release program, phase 1).

**Verdict: PASS — 0 live credentials in the full history of `canada-quant/digby`.**

Both repositories stayed PRIVATE throughout. No history was rewritten. No key
value appears in this document — prefix + tail only, per the standing rule.

---

## 1. The Cohere key

| Item | Value |
|---|---|
| Key shape | Cohere trial/production key, 40 chars |
| Prefix / tail | `DufVJOkW…CEli` |
| Found in `canada-quant/digby` history | **NO** — pickaxe `-S DufVJOkW` = 0 commits; `-S CEli` = 0 commits (over all 17 commits incl. the PR refs); 0 blob hits across all 3,849 blobs |
| Found in `example-org/crossmodel` history | **YES** — 4 commits (`753655e55`, `86e064307`, `6f4149749`, `53619d08a`) plus supervisor narration in `4607fb8b8` / `98809bdc5` |
| Found in `example-org/crossmodel` **HEAD tree** | **YES** — `memory-bank/crossmodel-projects-plan.md:25` (still present; see §5) |
| **Live probe** | `GET https://api.cohere.com/v1/models?page_size=1` → **HTTP 401** at 2026-11-04T18:35:34Z, body `"Incorrect API key provided: ****…CEli"` |
| **Verdict** | **DEAD — already revoked/disabled.** No revoke path needed; the owner's decision `oq_71ca7bf6` ("Revoke/disable the unused key") is satisfied by the key being dead. |

The 401 short-circuit means the previously-blocked dashboard path (paired Mac
`cql-stanne-mbp-1` offline) is moot — nothing was ever required from that device.

Extraction and probe were done in a private scratch dir (mode 700); the key file
was `shred -u`'d immediately after the probe. The value was never printed,
committed, or sent anywhere.

---

## 2. Method

Three independent passes over the **whole object database** of a clone of
`canada-quant/digby` at its **full ref set** — `main` (`f9803e7`) **plus the three
PR refs** `refs/pull/1..3/head`: **17 commits, 3,849 blobs, ~62.5 MB**. Not just
the current tree.

1. **Shape regex sweep** — hand-written rules for Cohere, AWS, GitHub, OpenAI,
   Anthropic, Slack, Google, Stripe, Twilio, SendGrid, Discord, Telegram,
   Moonshot, Bright Data, Asana, Xero, Plaid, PEM blocks, GCP service-account
   JSON, JWT, and password-bearing DB URLs. Every object in the database read via
   `git cat-file --batch`, including unreachable/dangling objects.
2. **Entropy sweep** — every 28+ char high-entropy token (Shannon ≥ 4.3) in
   non-test, non-doc blobs, hand-triaged.
3. **gitleaks 8.28.0 full history** — twice: once with the repo's own
   `.gitleaks.toml`, once with upstream defaults and **no path allowlist** so the
   repo's allowlist could not hide a finding.

### 2a. Ref-set coverage — a correction

**A default `git clone` fetches `refs/heads/*` only — it does NOT fetch
`refs/pull/*`.** `canada-quant/digby` has three PR head refs whose commits are
**not ancestors of `main`** (`0a0955e`, `0200fdb`, `85d9529`), so a plain clone
holds **7 of the 17 commits**: 10 commits existed only behind the PR refs.

The first version of this document claimed the PR refs "are reachable from
`main`, so the single `--all` walk covers the whole history." **That was wrong**
— and it was wrong in the *safe-to-know* direction only by luck: the walk was
incomplete, not the repository clean. The audit was therefore re-run after
`git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'`, over all 17
commits / 3,849 blobs. **Every number in §3 below is from the full-ref-set run.**

The gate conclusion did not move — the 10 extra commits added **zero** findings,
zero new files and zero new commits to the finding set — but the coverage claim
is what made the original verdict sound, so it had to be true.

> **Reproduction must fetch the PR refs first.** A clone that skips this step
> reproduces the original, incomplete 7-commit audit.

---

## 3. Findings — counts and verdicts

| Pass | Hits | Test fixtures | Production source | **Live-class** |
|---|---|---|---|---|
| Shape regex (all blobs) | 141 / 42 files | 135 | 6 | **0** |
| gitleaks, repo config (`gitleaks detect --log-opts=--all`) | **0** | — | — | **0** |
| gitleaks, defaults **without** the repo allowlist | 59 / 27 files | 57 | 2 | **0** |

No committed `.env` exists anywhere in the history — the only env files are
`backend/.env.example`, `frontend/.env.example`, `selfhost.env.example`, each
carrying placeholders only (verified line-by-line: the sole occurrences of
`COHERE_API_KEY` are `COHERE_API_KEY=your-cohere-api-key-here` and two
`${COHERE_API_KEY:-}` compose interpolations).

### 3a. Production-source hits — the 2 that survive with the allowlist removed

Both are **code identifiers**, not credentials, and both are exactly what the
repo's own `.gitleaks.toml` documents as reviewed false positives:

| File:line | Rule | Text | Verdict |
|---|---|---|---|
| `backend/src/modules/crossmodel/coding/context-gauge.ts:720` | `generic-api-key` | `t1PeakSimPromptTokens` / `this.t1PeakSimPrompt` — a camel-case telemetry field name | **FALSE POSITIVE** |
| `backend/src/modules/crossmodel/plaid/plaid-mcp.ts:359` | `plaid-client-id` | a `logger.info` line naming the `getRecurringTransactions` method | **FALSE POSITIVE** |

Both are introduced by commit `2d23199` (the seed commit) per gitleaks' own
`Commit` field, and unchanged since.

### 3b. Non-test shape hits that gitleaks does not flag (6)

| File | Pattern | Text | Verdict |
|---|---|---|---|
| `backend/.env.example` (3 blob versions) | db-url-with-pw | `postgresql://admin:password@localhost:5432/…` | **EXAMPLE** — dev placeholder in an `.env.example` |
| `docker-compose.yml` (2 blob versions) | db-url-with-pw | `postgresql://admin:password@postgres:5432/…` | **EXAMPLE** — local dev compose stack |
| `.gitleaks.toml` | private-key-block | an RSA private-key **opener** (`BEGIN`/`END RSA PRIVATE KEY` armor) wrapping a `MIIFAKEFAKE…` placeholder body | **DOC** — the allowlist's own comment quoting a placeholder |

### 3c. Test fixtures — 135 shape hits / 57 gitleaks hits across 26 test files

Every one is a deliberate fake input proving the secret-redaction / vault /
credential-detection code works. Representative shapes (all synthetic by
construction — repeated characters, sequential alphabets, `FAKE`/`AAAA`
mangling, or the word "never"/"dummy"/"fake" in the value):

- `sk-proj-` + a hand-typed mixed-case alphabet walk ending `…EF3GH6` —
  "sequential-ish" fixture reused across `owner-turn-context`,
  `owner-turn-history`, `supervisor-wake-ledger`,
  `tools.search-memory-supervisor`
- `sk-` + a single repeated letter + an ordinal digit (`AAAA…1`, `BBBB…2`,
  `CCCC…3`, `DDDD…4`) — deliverSecrets ordinal fixtures
- `AKIA` concatenated with `FAKEFAKEFAKE…`, with `…EXAMPLE`, or with
  `ABCDEFGHIJKLMNOP` — AWS-shaped fakes testing the AWS rule itself
- `ghp_` + a hex walk (`…Q7r8`, `…8B4a`), and `gho_` + the literal string
  `never_in_the_sandbox` — GitHub-shaped fakes
- `xoxp-`/`xoxb-` + a digit run + `abc`/`abcdefghij` — Slack-shaped fakes
- an RSA private-key armor opener with a `MIIFAKEFAKE…` body — PEM placeholder
- `eyJhbGciOiJIUzI1NiIs…` / `eyJraWQiOiJvYXV0aCJ9…` — the canonical jwt.io demo
  token and a hand-made JWT-shaped fake
- `postgresql://guard-test:guard-test@localhost:5432/guard-test` — throwaway
  local DSN set in `beforeAll` (creds are the literal string `guard-test`)

Files (all under `backend/src/modules/crossmodel/`): `chat-agent/chat-agent.owner-turn-context.test.ts`,
`coding/{credential-proxy,credentials.service,run-receipts,tools.search-memory-supervisor}.test.ts`,
`fleet/framework-signal-detectors.test.ts`,
`image-generate.test.ts`,
`model-endpoints/capability-detect.test.ts`,
`platform/{decision-gate,owner-answer-vault.[4 variants],owner-gate-sweeper,owner-question-secrets,owner-questions,owner-turn-history,platform-tools.ops-tools,premise-register,secret-scan,secret-vault-advisories,supervisor-state.service,supervisor-wake-ledger}.test.ts`,
`rag.family-5ae52ca3.test.ts`, `user-mcp/user-mcp.service.test.ts`.

**Commit attribution:** gitleaks' own `Commit` field names **`2d23199` (the seed
commit) for every one of the 59 findings** — i.e. every credential-shaped string
shipped in the initial carve-out commit. Later commits (`d657dfd`, `9a8432d`)
*edited* many of these files (that is why `git log -- <file>` lists them) but
introduced no new finding. Attribution here uses the `Commit` field because it
records the commit that actually *added* the text, which is what a reader needs.

### 3d. Entropy sweep — 12 flagged, 0 credential-shaped

`ABCDEFGHJKLMNPQRSTUVWXYZ23456789` (a base32 alphabet constant), three Apple
`www.apple.com/DTDs/…` namespace URLs, a launchd plist identifier, an
`OLD_SQLITE=…` install path, a PNG magic-byte prefix inlined in a test, two Rust
`Win32_System_*` feature names from `Cargo.toml`, a `READINESS_BARS` key, and a
`ROOT/frontend/public/…png` path. None is a secret.

---

## 4. Why this supersedes the earlier 206-hit classification

The previous classification (`todo 8ae3cb68`, done) scanned the **source** repo
`example-org/crossmodel` and reported 206 credential-shaped hits / 85 files / 77
commits. It was treated as a reference, not as truth, exactly as the brief
required. `canada-quant/digby` is a **carve-out**: it is much smaller (17 commits,
3,849 blobs vs. crossmodel's 5,515 commits) and the carve-out commits
(`9a8432d`, `99efbfa`, `7da10f4`, `d657dfd`, `a888bec`) deliberately neutralised
production markers. The numbers above are measured on digby itself.

The `.gitleaks.toml` allowlist that ships in the repo was **independently
verified accurate**: removing it exposes 59 findings, of which 57 are the
redaction-test fixtures it names and 2 are the identifiers it documents. No
entry in that allowlist hides a real credential.

---

## 5. Residual items (not publish blockers)

1. **`example-org/crossmodel` working tree still carries the dead key** at
   `memory-bank/crossmodel-projects-plan.md:25`. The key is **dead (401)**, so
   this is inert, and `crossmodel` stays PRIVATE — outside the publish gate. A
   single working-tree deletion (no history rewrite) would tidy it; deliberately
   **not** done here because the brief forbids history rewrites and this file is
   a historical memory-bank note.
2. **`canada-quant/digby` CI scans only the worktree**, not history:
   `.github/workflows/ci.yml` runs `gitleaks dir .` (gitleaks 8.30.1). The CI
   gate therefore cannot catch a historical leak. If history scanning should be a
   permanent guard rather than a one-off audit, change that step to
   `gitleaks git --log-opts="--all"`. Not required for the flip — the history is
   clean today, evidenced above.

---

## 6. Reproduction

```bash
git clone https://github.com/canada-quant/digby.git /tmp/digby-audit
cd /tmp/digby-audit
# ⚠ REQUIRED: a plain clone omits the PR refs. Without this line you audit
#   7 of 17 commits — the exact mistake this document corrects in §2a.
git fetch origin '+refs/pull/*/head:refs/remotes/origin/pr/*'

git rev-list --all --count                 # 17
git rev-list --all --not origin/main --count   # 10 commits only behind PR refs
git cat-file --batch-check --batch-all-objects | awk '$2=="blob"' | wc -l  # 3849

# 1. Cohere pickaxe (over the full ref set)
git log --all --oneline -S 'DufVJOkW'      # (empty)
git log --all --oneline -S 'CEli'          # (empty)

# 2. gitleaks full history, repo config
gitleaks detect --log-opts="--all" --redact --report-format json --report-path gl.json
#    -> "16 commits scanned ... no leaks found"

# 3. gitleaks with the allowlist removed (prove it hides nothing)
printf 'title = "no allowlist"\n[extend]\nuseDefault = true\n' > /tmp/nostrict.toml
gitleaks detect --log-opts="--all" --config /tmp/nostrict.toml --redact \
  --report-format json --report-path gl_nostrict.json   # 59 findings, 0 live
```

Result: **`gitleaks detect --log-opts="--all"` → "no leaks found"** (16 commits,
62.53 MB); with the allowlist stripped, the same 59 findings / 27 files appear at
commit `2d23199` and triage to 0 live-class. Both passes were re-run over the
full ref set after the coverage correction in §2a, and produced **byte-identical
finding sets** to the original 7-commit run.