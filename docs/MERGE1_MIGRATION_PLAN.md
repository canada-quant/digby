# MERGE-1 — object model: one session, coding as a capability

> **Measurement + migration plan. Docs-only. No production mutation, no migration run.**
> Measurements taken **2026-11-02 13:13–13:27Z** (05:13–05:27 PST) on branch
> `digby/session-70d96298` at base `1b80e20eff` (= `origin/main`). Every path/line
> below was read on **that** tree in that window; where a count is quoted, the
> command that produced it is quoted with it.
>
> Source of record: `docs/DIGBY_PLATFORM_UNIFICATION_PLAN.md` → *Option 3*,
> `docs/ONE_SESSION_PLATFORM.md` → *Phase P3 + P4*, `docs/FRAMEWORK_BACKLOG.md` →
> `### SAA-1`. Problem statement lives in todo `2fd4416a` under goal `d605db05`.

---

> ## ⚠ STATUS CHANGE 2026-11-04 (read before using any `TRANSCRIPT_*` instruction below)
>
> **Every `TRANSCRIPT_READ` / `TRANSCRIPT_WRITE` / `TRANSCRIPT_DUAL_WRITE` lever described
> in this document has been REMOVED.** `coding/transcript-source.ts` is deleted, its
> `TRANSCRIPT_*` forwards are gone from `docker-compose.app.yml`, and every transcript
> read and write now targets `crossmodel_messages` unconditionally. Setting any of those
> env vars today does nothing.
>
> **What that means for the sections below:** the step 3/4/5 *prose* is the historical
> plan and its rollback advice is EXPIRED. `TRANSCRIPT_READ=legacy` is no longer a
> rollback, and `TRANSCRIPT_WRITE` cannot select a direction. The surviving rollback for
> the DROP is a **database restore**; there is no env-level read/write switch any more.
>
> **Why the levers went:** they existed to keep a one-release read-rollback honest. The
> merged-only write window was proven live on the deployed build (`6bff8539`; probe
> `scripts/framework-audit/transcript-write-window.js` at 2026-11-04T13:35Z → legacy
> delta 0, merged delta +1), so the rollback had no reader left and the switch became a
> switch over a table about to be dropped — i.e. a runtime landmine rather than a safety
> net. The status table in §0 carries the current state; this banner governs if the two
> disagree.

> ## ⚠ STEP 5 EXECUTED 2026-11-04 — `coding_messages` IS DROPPED
>
> The irreversible step below is no longer a plan. Migration
> `backend/prisma/migrations/20261104150000_drop_coding_messages/migration.sql` drops the
> table, and `model CodingMessage` is deleted from `schema.prisma`.
>
> **Pre-drop gate, re-measured on the DEPLOYED build `7231cdb4`** (not on a plan-time
> tree): `scripts/framework-audit/transcript-drop-gate.js` inside `admin-worker-green`
> at 2026-11-04T15:07Z → `missingInMirror 0`, `chatsWithMissing 0`, `legacyOnlyChats 0`,
> `DROP_SAFE: true` over 400 sampled chats. Table at drop: 43,917 rows / 1,523 MB.
> No constraint or view referenced it (`pg_constraint`/`pg_depend` both empty), so the
> drop needed no CASCADE.
>
> **`scripts/backfill-coding-transcripts.ts` was DELETED in the same change** and its
> `backfill:transcripts` npm alias removed — it read `coding_messages` by raw SQL, so
> after the drop it could only fail. Its replacement for any historical comparison is the
> drop gate above, which lives in the operator lane (`scripts/framework-audit/`).
> **Steps 2–4 below are therefore historical**: the backfill already ran, and the gate it
> describes has been superseded by the `DROP_SAFE` subset check.
>
> **Rollback: none in code.** Recovery is a database restore to the pre-migration
> snapshot (nightly dump on box A), which is an owner decision, not a forward-fix.

> ### ✅ POST-DROP CONFIRMATION 2026-11-04T16:31:36Z (on the SERVING build `99114c0c`)
>
> Migration `20261104150000_drop_coding_messages` finished at `2026-11-04 15:58:58.936Z`
> (`_prisma_migrations`, `rolled_back_at` null). Verified inside `admin-worker-blue` on
> `99114c0ce6ec` with an ad-hoc read-only Prisma probe run through
> `scripts/framework-audit/run-on-box.sh C` (not a repo script — the repo's
> `transcript-drop-gate.js` SELECTs `coding_messages`, so after the drop it can only
> report `42P01`; that failure is itself one half of the proof):
>
> - `to_regclass('public."coding_messages"')` → **null**; `pg_class` has no relation of
>   that name in any schema; `pg_depend` returns no dependents.
> - `prisma.codingMessage` → **undefined** (the client no longer exposes the delegate).
> - The new sweep predicate `chat: { chatMessages: { none: {} } }` runs clean
>   (`rows: 1`); the old `FROM "coding_messages"` probe now fails `42P01`, which is the
>   expected half of the proof.
> - `crossmodel_messages` still taking writes: newest `2026-11-04 16:31:00.696`,
>   12 rows in the trailing 10 min.
>
> **A ~13-minute warn burst (`first-prompt-recovery`, 15:59–16:12Z) is expected and
> closed.** It reads `Invalid prisma.chatCodingState.findMany() … The table
> public.coding_messages does not exist`, which looks like a code bug but is not: a
> `chatCodingState` call cannot mention `coding_messages` unless the running client is the
> PRE-drop one, whose `messages: { none: {} }` filters through the `CodingMessage`
> relation. All 20 rows fall before `admin-worker-blue` (the DROP build) started at
> 16:16:11Z, and none after — the noise is the blue-green overlap doing its job, not a
> regression. **Reading rule:** on a schema-dropping migration, bucket these warnings by
> whether they PREDATE the new colour's start; "table does not exist" from a stale
> container is the drain finishing, not a fault to chase.

---

## 0. Executive summary — the plan in this doc is NOT the plan in the charter

The charter describes MERGE-1 as five sequential steps starting from "dual-write".
**Four of those five already shipped between 2026-07-27 and 2026-08-31.** This
document therefore does not re-plan work that exists; it re-baselines the remaining
work and names the real seam.

| Charter step | Actual state on this tree | Evidence |
|---|---|---|
| Dual-write `CodingMessage → CrossModelMessage` | **SUPERSEDED 2026-11-04** — the mirror is GONE | `coding/coding-data.service.ts` (`appendCodingMessage`): a single `crossModelMessage.create`. The `TRANSCRIPT_DUAL_WRITE` lever was removed with the seam (step 9). |
| **Write convergence — merged is the PRIMARY target** | **LANDED 2026-11-04**, and **completed by step 9**: merged is now the ONLY target | `coding/coding-data.service.ts` `appendCodingMessage`/`updateCodingMessage` write `crossmodel_messages` and nothing else. The `transcript-source.ts` seam (`transcriptWritePlan`, `transcriptReadMode`, `pickTranscriptSource`, `transcriptDualWriteEnabled`) and its `TRANSCRIPT_*` env forwards in `docker-compose.app.yml` were **deleted** once the merged-only window was proven live (probe `scripts/framework-audit/transcript-write-window.js`: legacy delta 0 / merged delta +1 on the deployed build `6bff8539`, 2026-11-04T13:35Z). No switch can route a write to the legacy table any more. |
| Backfill `sessionId → chatId` | **LANDED** (script, idempotent + resumable) | `backend/scripts/backfill-coding-transcripts.ts:1-33` (keyset scan, `ON CONFLICT ("id") DO NOTHING`) |
| Per-chat row-count + checksum gate | **LANDED** (`--verify` mode) | `backfill-coding-transcripts.ts:159-182`, exit 1 on any mismatch; `:201` |
| Read-switch to `crossmodel_messages` | **RETIRED 2026-11-04** — every read serves `crossmodel_messages` unconditionally | The `TRANSCRIPT_READ` switch and the per-chat legacy fallback were both removed in step 9; `listCodingTranscript` / `listCodingTranscriptPage` / `listRecentCodingTranscript` / `countCodingTranscriptMessages` / `getFirstUserCodingMessage` each have a single merged arm. |
| Drop `coding_messages` | **NOT DONE** — table + `CodingMessage` model still live | `prisma/schema.prisma:862-884` (`@@map("coding_messages")` :883) |
| Delete the `mode='code'` guard (`crossmodel.controller.ts:837`) | **ALREADY DELETED** — `:837` is now `updateChatSchedule`'s `const { id, scheduleId }` | deleted by commit **`8b47928d55`** "feat(P5-B): coding as per-message capability — **guard deleted**, lazy workspace, mode migration" |
| Harness profile **per message** by capability | **LANDED** (routed by the satellite, not by a sticky flag) | `crossmodel.controller.ts:1626-1645` ("P5: per-message profile routing — the SATELLITE, not sticky mode") |
| `ChatCodingState → ChatWorkspaceState`, lazy | Satellite **is** lazy; **model not renamed** | lazy: `getChatCapability` + the batched `getChatCapabilities` (`coding-data.service.ts`, the `ChatCapability` block), `ensureChatWorkspaceState`; rename: 111 sites / 43 files |
| `CodingSchedule → ChatSchedule` | **DONE — Prisma-level rename LANDED (2026-11-04)**; table still `coding_schedules` | `model ChatSchedule` `schema.prisma:1448` with `@@map("coding_schedules")` :1548 unchanged (zero data movement); 1005 `chatSchedule` delegate refs across 251 files; firing was already generalized (`schedule.service.ts:4454` vs `:4563`) |

**So MERGE-1 is not a greenfield migration.** It is: (1) close the readers that
bypass the read-switch, (2) run the gate and prove it green across the fleet,
(3) drop a table, (4) two Prisma-level renames with **no** data movement
(`@@map` stays). Steps 1–4 of the charter's list are *done and in production*, and
the risk has already moved to a different place than the plan assumed (§4).

**One correction to the recorded state that matters:** the repo's own plan doc is
marked `ARCHIVED 2026-09-28` and states the P5 remainder "is NOT planned"
(`DIGBY_PLATFORM_UNIFICATION_PLAN.md:3-9`). This doc is a deliberate re-open of that
one seam, justified by the SAA-1 board dependency — record the conflict rather than
silently overriding it, and if the board wants it left archived, this file is the
thing to delete.

---

## 1. What was measured (counts + the commands that produced them)

### 1.1 The two models

`CrossModelMessage` — `backend/prisma/schema.prisma:332-352`, table
`crossmodel_messages` (`:351`):

| column | type | note |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `chatId` | `String` | direct |
| `role` | `String` | comment: `'user' \| 'assistant'` |
| `content` | `String @db.Text` | |
| `metadata` | `Json?` | model responses / timing |
| `parts` | `Json?` | **`:338` — "ordered agent parts (CodingMessage shape); null = legacy pipeline"** |
| `createdAt` / `updatedAt` | `DateTime` / `DateTime?` | |

`CodingMessage` — `schema.prisma:862-884`, table `coding_messages` (`:883`):

| column | type | note |
|---|---|---|
| `id` | `String @id @default(uuid())` | |
| `chatId` | `String @map("sessionId")` | physical column is `sessionId` (`:864`) |
| `role` | `String` | comment adds `"system"` (`:865`) |
| `content` | `String @db.Text` | |
| `parts` | `Json?` | **`:867` — identical ordered-parts shape** |
| `metadata` | `Json?` | `:871` — additive, "Mirrors into crossmodel_messages.metadata" |
| `createdAt` / `updatedAt` | `DateTime` / `DateTime?` | |

**VERIFIED, not assumed: `CrossModelMessage.parts` does supersede `CodingMessage`'s
body shape.** All five body columns are 1:1 (`role`, `content`, `parts`, `metadata`,
`createdAt`); the only structural differences are (a) the physical column name
`sessionId` vs `chatId` — already bridged (`schema.prisma:860-861`: "session id ==
chat id, so no data movement was needed"), and (b) `CodingMessage`'s doc-comment
permits `role='system'` while `CrossModelMessage`'s permits two values. The second
is a **comment-only** divergence: both columns are free-form `String`, and the
coding harness's `role:'system'` turns (`coding/agent.ts:1848, 3820-3982`) are
**provider-payload messages, not transcript rows** — no `appendCodingMessage` call
site writes `role:'system'`. The drop is therefore physically a no-op on shape.

### 1.2 Read/write sites

| what | count | command |
|---|---|---|
| `prisma.codingMessage.*` call sites, production code | **15 sites / 6 files** | `grep -rn "prisma\.codingMessage" src --include=*.ts \| grep -v "\.test\."` |
| … in tests | **62** | same, `--include=*.test.ts` |
| `chatCodingState` call sites, production code | **111 sites / 43 files** | `grep -rn "chatCodingState" src --include=*.ts \| grep -v "\.test\."` (sites) / `grep -rl … \| wc -l` (files) |
| raw SQL naming `coding_messages` | **2 writers of the name**: 1 production statement + 1 operator script | `agent-events-retention.service.ts:288`; `scripts/backfill-coding-transcripts.ts` (13 occurrences) |
| `mode === 'code'` / `!== 'code'` in **backend production** code | **0** | `grep -rn "mode === 'code'\|mode !== 'code'" src --include=*.ts \| grep -v "\.test\."` |
| `mode === 'code'` remaining in **frontend** | **5** (legacy/UI only) | `frontend/lib/chat-flavor.ts:34`, `lib/preferences.ts:46`, `lib/depth-ux.ts:57`, `app/crossmodel/page.tsx:1229`, `:1486` |
| `ChatSchedule` model | **1 (renamed 2026-11-04)** | `grep -c "model ChatSchedule" prisma/schema.prisma` |
| registered switches | **568 rows** | `grep -c "^  { name: '" platform/switch-registry.ts` |

**The 15 production `codingMessage` sites, classified.** The five routed through
`coding-data.service.ts` helpers are read-switch-aware and drop-safe. The rest are
not:

| # | site | what it does | drop-safe? |
|---|---|---|---|
| 1 | `coding-data.service.ts:1019` | `create` (dual-write write path) | yes — replaced by the mirror |
| 2 | `coding-data.service.ts:1061` | `update` (dual-write write path) | yes |
| 3 | `coding-data.service.ts:1085` | `count` — per-chat legacy-fallback probe | becomes a no-op after drop (empty table) |
| 4 | `coding-data.service.ts:1111/1140/1156/1185` | paged + unpaged transcript reads (legacy branch) | yes — merged branch is default |
| 5 | `coding-data.service.ts:1193/1215` | role count / first-user-message (legacy branch) | yes |
| 6 | **`firing-superseded-gate.ts:161`** | reads assistant `content/parts/metadata` for a superseded firing | **NO — bypasses the switch** |
| 7 | **`run-executor.ts:836`** | `count` of steer-adoption candidate ids (idempotency guard, `:824-838`) | **NO — bypasses the switch** |
| 8 | **`run-reaper.ts:509`** | recent-activity probe (`createdAt >= cutoff`) | **NO — bypasses the switch** |
| 9 | **`session-history-sync.service.ts:434`** | builds the session-history markdown transcript | **NO — bypasses the switch** |
| 10 | **`agent-events-retention.service.ts:288`** | raw SQL `SELECT cm.id FROM coding_messages cm` inside `FINAL_MESSAGE_LATERAL` (the `complete` compaction tier) | **NO — raw SQL, invisible to any Prisma-level guard** |
| 11 | **`session-status.service.ts:388-390`** | newest status row — keys on **`transcriptDualWriteEnabled()`**, *not* `transcriptReadMode()` | **NO — and flag-mismatched** (Step 1 below closes it) |
| 12 | `coding.controller.ts:376` | image-part lookup: probes `crossModelMessage` then falls back to `codingMessage` (shared id family) | yes — merged-first |

### 1.3 Schedules

There is **one `ChatSchedule` model** (renamed from `CodingSchedule` 2026-11-04;
`schema.prisma:1448-1550`, table still `coding_schedules` via `@@map` at `:1548` —
Prisma-level only, zero data movement), and
its **behaviour was already generalized**: the sweeper fires a coding run when the
chat carries a satellite (`startScheduledRun`, `schedule.service.ts:4454`) and a
detached chat run otherwise (`startDetachedChatRun`, `:4563`), documented at
`platform.service.ts:3532` ("Schedule a run against ANY chat (generalized
`ChatSchedule`)"). **So "schedules unify" was a rename + doc task with zero data
movement, not a merge.** Its `@@map` must stay `coding_schedules` in the rename
release (Prisma-level first, physical later — `ONE_SESSION_PLATFORM.md:232`).

### 1.4 Stream / attach paths

The unified endpoint **already exists**: `GET /api/crossmodel/chats/:id/stream`
(`crossmodel-open.routes.ts:313` → `crossmodel.controller.ts:492` `streamChatRun`).
Both retired endpoints 308 to it with the query string preserved
(`coding-public.routes.ts:29-32`; `crossmodel.controller.ts:454-465`). Seven
run-relevant SSE endpoints remain; classification in §5.

---

## 2. Ordered migration steps, gates and rollbacks

**Global preconditions (all steps).** No step ships while CI is red; base is
`origin/main` at the time of the PR (not the branch's fork point). Every step is its
own PR with its own gate. **Blue-green overlap is mandatory from step 3 onward**
(§6). No step in this plan changes an execution tier — interactive fast-path and
durable worker stay separate (`2fd4416a`: "research verdict never C").

### Step 1 — one transcript accessor; close the six bypass readers
**Change.** Route the five hard bypasses (§1.2 #6–#10) and the flag-mismatched
reader (#11) through the read-switch seam. No new abstraction is needed: the
merged-branch reads already exist (`coding-data.service.ts:1111-1215`). #10 is the
hard one — its raw SQL must read `crossmodel_messages` (the `complete` tier strips
`agent_events.payload.parts` and records `messageId`, so the lateral only needs an
id + `createdAt` window).

**Landed as:** the switch predicates + `pickTranscriptSource` moved verbatim into a
**leaf module** `coding/transcript-source.ts` (imports only `prisma` + `logger`), which
`coding-data.service.ts` re-exports unchanged. That move is deliberate, not cosmetic:
`coding-data.service.ts` imports `middleware/error-handler` → `config/env`, which calls
`process.exit(1)` at import time without a full env — so routing
`firing-superseded-gate` (reached transitively by ~24 `schedule*.test.ts` suites)
through it turned one change into 25 red suites. The leaf keeps the seam shared without
that edge. Behaviour under `TRANSCRIPT_READ=legacy` is unchanged.

**Gate.**
- `coding-data.service.test.ts` — all transcript-shape assertions pass on both
  `TRANSCRIPT_READ` values.
- The existing legacy-fallback paging coverage (`coding-data.service.test.ts:618`,
  "legacy fallback pages coding_messages") still passes with
  `TRANSCRIPT_READ=legacy`, and a new mirrored-table twin of it passes with
  `merged` — **the same test body, both flags.**
- **Compaction tier gate (the one no existing test covers):** with
  `TRANSCRIPT_READ=merged`, the `complete` tier's `apply` statement must report
  `COUNT(*) > 0` over a fixture whose only message row is a *mirror*. Today that
  fixture would report 0 — that is the test that proves the patch, and it is the
  detection §4 asks for.

**Rollback.** Revert the PR. Nothing irreversible happens; the table is untouched and
`TRANSCRIPT_READ=legacy` still serves every chat.

### Step 2 — run the gate fleet-wide and require it green
**Change.** None (operational). Run
`cd backend && npx tsx scripts/backfill-coding-transcripts.ts` then `--verify`.

**Gate — this is the step that authorizes the drop.** `--verify` exits non-zero only
when a **legacy message has no mirror row**. The gate is a **subset check**:
`legacy ids NOT IN mirror == 0`, per chat (`MISSING_SQL` in
`backfill-coding-transcripts.ts`). `--verify` prints three classes so a run is legible:

| Class | Meaning | Gates? |
|---|---|---|
| `ok` | every legacy id mirrored **and** the parts digest matches | — |
| `digest-only` | every legacy id mirrored, parts digest differs | **NO — diagnostic** |
| `missing-in-mirror` | ≥1 legacy id absent from the mirror | **YES** |

Proceed **only** at `totalMissingRows === 0` across every chat that has legacy rows.
A single missing row is a blocking defect, not a rounding error: that message becomes
unreachable the moment `coding_messages` is dropped.

> **Why the gate is NOT row-count equality (measured 2026-11-02).** The original gate
> was `count(legacy) == count(mirror)` per chat. That is **unsatisfiable** once one
> session carries both a chat profile and a coding profile — the merged transcript
> correctly holds chat-profile turns `coding_messages` never saw. Measured fleet-wide:
> **125 of 1700 chats** reported `mirrored > legacy` (deltas +1…+75) *by design*, so
> the old gate could never go green. The equality check was the defect, not the data.

> **`digest-only` is ACCEPTED as by-design mirror enrichment — do not gate on it.**
> 373 of 1700 chats landed in this class at measurement. The evidence: **658 shared
> rows have `parts IS NULL` on legacy and non-NULL on the mirror**, and the newest
> examples were hours old (`8e1cd477` @ 2026-11-02 14:38Z, `481946ee` @ 13:12Z) — a
> **mirror-only write path** records the final result card onto `crossmodel_messages`
> and never back-fills `coding_messages`. The mirror is the *richer* side. Where both
> sides are non-NULL the parts differ only inside tool JSON (`args`/`ts`): 9 longer,
> 42 shorter by ≤49 chars on 220 KB payloads, and the human-readable **text differs on
> 11 of 42,571 shared rows**. None of that is a lost message.

> **`metadata` is still never compared, and the digest is NOT widened now.** The
> backfill inserts `metadata` as `NULL` (no legacy counterpart — column-list comment at
> `:57`, mapping note at `:24`) while the dual-write path carries a real value, and the
> digest signature remains `id|createdAt|length(parts::text)`. Widen it to cover
> metadata **only if a future step actually needs metadata parity** — that would also
> require the backfill to carry metadata first. Neither exists today; do not widen it
> speculatively.

**Rollback.** None needed — the backfill is idempotent (`ON CONFLICT ("id") DO
NOTHING`) and resumable by keyset, so a partial run is resumable, and re-running
converges. This is the one step that is safe to interrupt.

#### Step 2 — MEASURED 2026-11-02 14:50–15:00Z: the gate is RED, and the defect is the GATE

> **Result: `mismatched = 499` of 1700 chats — FAILED. Step 3 is therefore blocked.**
> The run was READ-ONLY (`--verify` writes nothing). It ran on prod box A
> (`i-0123456789abcdef0`) via SSM into `admin-backend-blue`, executing the script's
> **own SQL constants** (`CHATS_SQL`, the two `digestSql` bodies) through the
> container's Prisma client — the image ships a compiled build with no `tsx`, so the
> `.ts` entrypoint itself cannot run there. SSM command `b0fcbf3e-fec9-4249-8ec9-5b4b01de825e`.

Everything below is measured on that tree, not inferred:

| Class | Count | Meaning |
|---|---|---|
| OK (count + digest equal) | 1201 | genuinely converged |
| **digest-only** mismatch (same row count) | **373** | `parts` differ on shared ids |
| **count** mismatch | **126** | row counts differ |
| — of which `mirrored > legacy` | **125** | **one-session merge — see (B)** |
| — of which `mirrored < legacy` | **1** | **real loss — see (C)** |

Table facts at measurement: `coding_messages` **42,572 rows / 1474 MB**;
`crossmodel_messages` **108,270 rows / 2568 MB**. Shared ids **42,571**;
`chatId` differs **0**; `createdAt` differs **0**. Content (the message text) differs
on only **11** of 42,571 shared rows.

**(A) The 373 digest-only mismatches are the dual-write path enriching the mirror.**
Of 42,571 shared rows, 658 have `parts IS NULL` on legacy and non-NULL on the mirror,
with `partslen_differs = 709` overall (658 + 9 longer + ~42 shorter). The newest
examples are hours old (`8e1cd477` @ 2026-11-02 14:38Z, `481946ee` @ 13:12Z): a
**mirror-only write path** records the final result card / parts onto
`crossmodel_messages` and never writes them back to `coding_messages`. Where both
sides are non-NULL the mirror is LONGER on 9 rows and SHORTER on 42, by at most 49
chars on a 220 KB payload — signature drift inside tool JSON (`args`/`ts`), visible
only at that granularity; the human-readable text matches (content differs on 11).

**(B) 125 of the 126 count mismatches can NEVER converge — this is the plan's real
defect.** MERGE-1's own thesis is one session carrying both a chat profile and a
coding profile in one transcript. The gate is `SELECT sessionId FROM coding_messages
GROUP BY sessionId` — i.e. it compares a **coding-only** row set against a **merged**
one that *correctly* contains chat-profile turns too. Every chat that exercises the
merged object model reports `mirrored > legacy` (deltas +1 … +75). **A per-chat
row-count equality check is unsatisfiable by construction for exactly the sessions
this migration exists to create.** The gate must compare the **legacy id set as a
subset** of the mirror (`legacy_rows NOT IN mirror == 0`), not `count(legacy) ==
count(mirror)`.

**(C) One real loss — 1 row.** Chat `5cbad8e9-4394-44b1-9a1d-ee8367b5f24b`: legacy 36,
mirrored 35, zero mirror-only rows. The missing row is
`0791aa61-058e-4552-b73f-549f88286bd7` (`role=assistant`, `createdAt`
2026-07-31 15:12:35Z, 1888-char content). It predates the backfill; cause not
established. **This row becomes permanently invisible the moment the per-chat
fallback is retired** — which is precisely what Step 3 does.

**Consequence — superseded by the re-specification above (2026-11-02).** Under the
ORIGINAL gate this measurement blocked Step 3 outright: its precondition was
`mismatched === 0` and it was 499. That verdict is now resolved in three parts, and the
reasoning is recorded rather than deleted:

- **(A) → resolved as by-design.** Accepted as mirror enrichment (see the
  `digest-only` note above). It never was data loss: the mirror is the richer side.
- **(B) → the gate was the defect.** Re-specified to a subset check. The 125
  `mirrored > legacy` chats PASS under it.
- **(C) → authorized for additive repair.** The single missing row is backfilled with
  the idempotent, additive pass (`INSERT … ON CONFLICT ("id") DO NOTHING`, no DDL / no
  DELETE / no UPDATE), on the Fleet Supervisor's explicit authorization — not the
  owner's, and scoped to pre-drop convergence only.

**Step 3 stays blocked until the subset run reports `totalMissingRows === 0`.** That is
the one number that matters now. Retiring the per-chat fallback while a legacy row has
no mirror row would make that row permanently unreachable — the fallback is the only
thing still serving it.

### Step 3 — retire the per-chat legacy fallback (read-switch goes sticky)
**Change.** After step 2 is green fleet-wide, remove the per-chat fallback so `merged`
stops probing `coding_messages` per chat. `TRANSCRIPT_READ=legacy` stays available as the
release-level rollback.

> **Site moved (slice 1, 2026-11-02).** The fallback now lives in
> `coding/transcript-source.ts:48-63` (`pickTranscriptSource`), not
> `coding-data.service.ts:1082-1089` — slice 1 moved the switch predicates + picker into
> that leaf module to break an import cycle, and `coding-data.service.ts` re-exports them
> unchanged. Any later step that names the old line numbers is stale.

**Gate (the charter's three, made executable).**
1. **Plain chat goes coding mid-thread and back, history intact.** A chat with no
   satellite: send turn 1 (chat profile) → attach a workspace (send-time router) →
   send turn 2 (coding profile) → assert the transcript read returns turn 1 **and**
   turn 2 in `createdAt` order from the merged table, and that turn 1's sender is the
   chat pipeline. Then detach/no-op and send turn 3 — still one transcript.
2. **Existing coding-session transcript still loads.** `GET /coding/sessions/:id`
   with `messageLimit` paging returns byte-identical rows to the pre-change build for
   a fixture chat (the paged read is `coding.controller.ts:288-300`).
3. **No session enters a stream path its capability does not grant.** Covered by the
   §5 matrix — run the two negative cases: a satellite-less chat must 404/400 on the
   coding entries, and a child account must 403 (`coding-stream.controller.ts:589`,
   `crossmodel.controller.ts:529`).

**Rollback.** Set `TRANSCRIPT_READ=legacy` (env, no deploy) — restores the pre-switch
read for the whole fleet. This is the "one-release read-rollback" the charter asks
for, and it **expires with step 5**.

### Step 4 — soak on both colors
**Change.** None. Steps 1–3 must be **running identically on both blue and green**
for at least one full release before step 5. Why: the read-switch is read **per
call, not per process** (`coding-data.service.ts:947-954`), so the two colors can
disagree about which table is authoritative while both are serving. During the
overlap window the rule is: **dual-write stays ON for both colors**
(`TRANSCRIPT_DUAL_WRITE !== 'off'`), so whichever table a color reads, the other is
current.

> **Write convergence (2026-11-04, before step 5 could run).** Steps 1–3 converged the
> READS only: until now `appendCodingMessage`/`updateCodingMessage` primary-wrote
> `coding_messages` and mirrored into `crossmodel_messages`, so dropping the legacy
> table would have broken every transcript write. The direction is now inverted —
> merged is the primary target, legacy the mirror in the same transaction — which makes
> `TRANSCRIPT_READ=legacy` a *complete* rollback (it would otherwise return an empty
> transcript for every chat written after the inversion). `TRANSCRIPT_WRITE` selects
> the direction per call: unset/`mirror` (default) = both tables, `merged` = merged
> only, `legacy` = pre-inversion. Step 4's rule is unchanged but its reason widens:
> **while both colors are serving, neither may run `TRANSCRIPT_WRITE=merged`**, because
> the color still reading `TRANSCRIPT_READ=legacy` would see no new rows at all.

**Gate.** A full release observed with (a) both colors reporting the same
`TRANSCRIPT_DUAL_WRITE`/`TRANSCRIPT_READ` values, (b) `--verify` re-run green at the
end of the window, (c) zero `transcript read-switch: chat … serving legacy` warns in
either color's log for the whole window — a single warn means the fallback is still
load-bearing and step 5 must wait. (The warn is emitted by `pickTranscriptSource` in
`coding/transcript-source.ts:56`; the old `coding-data.service.ts:1089` reference is
stale since slice 1 moved the seam. Note it can only fire for a chat with legacy rows
and zero mirrored rows, which after a green step 2 does not exist.)

**Rollback.** None needed.

### Step 5 — drop `coding_messages` (the irreversible step)

#### Pre-drop packet — MEASURED 2026-11-02 15:35–15:41Z (prepare only; NOT executed)

Everything below was read from prod RDS (`example-db`) and AWS, **read-only**.
This is the packet the Fleet Supervisor takes to the owner. **Nothing here has run.**

**What the drop removes.** `coding_messages`: **42,585 rows / 1474 MB / 3 indexes**.
**Legacy-only rows that exist nowhere else: 0** (`LEGACY_ONLY_ROWS=0`) — every legacy
row already has a mirror row. The drop removes a table whose content is fully
replicated in `crossmodel_messages` (**108,307 rows / 2568 MB**, 2997 distinct chats).

**Blast radius — verified, not assumed.** **0** FK constraints point at the table;
**0** views/matviews depend on it. A plain `DROP TABLE` is unblocked and takes nothing
else with it.

**Exact SQL (the migration body).**
```sql
DROP TABLE "coding_messages";
```
Prisma removals that must ride the same PR or the client breaks:
`model CodingMessage` (`schema.prisma:862-884`), the relation field
`messages CodingMessage[]` (`schema.prisma:850`), and every remaining
`prisma.codingMessage` call site (Step 5's gate list above).

**Restore point / rollback path — concrete.**
- RDS **`example-db`** — `db.r7g.large`, PostgreSQL **16.13**, 400 GB,
  encrypted, **DeletionProtection: true**, backup window **08:28-08:58 UTC**,
  **PITR retention 7 days**.
- Latest restorable time at measurement: **2026-11-02T15:32:46Z**.
- Only manual snapshot on the instance: **`example-db-pre-upgrade-20261006`**
  (2026-10-06T16:39Z — **27 days old**). There is no recent manual snapshot; taking one
  immediately before the drop is the recommended extra step.
- Restore = RDS point-in-time restore into a **new instance**, then re-point
  `DATABASE_URL`. Runbook: `docs/BACKUPS.md` § *Restore runbooks*.

**What is lost if the restore point is stale.** A PITR restore rewinds the WHOLE
database, not just this table — so a stale restore point never loses `coding_messages`
data (it is all mirrored). It loses **everything written since that point**:
**1,543 `crossmodel_messages` rows in the last 24 h**, **9,654 in the last 7 days**
(= the entire PITR window), across 2997 chats. That is the real cost of a rollback,
and the reason the safety window is one release rather than one deploy.

**Gate status at measurement.** Re-specified `--verify`: **1700 chats — ok 1202,
digest-only 498 (diagnostic), missing-in-mirror 0, totalMissingRows 0 → PASSED.**
Steps 3 (fallback retirement) and 4 (soak) are still ahead of the drop.

**Change.** One migration: `DROP TABLE "coding_messages"`; delete `model
CodingMessage` (`schema.prisma:862-884`) and the `messages CodingMessage[]` relation
(`:850`). Do **not** combine this migration with any rename (steps 6–7).

**Gate.** Pre-drop, all of:
- Step 1's bypass list re-grepped to **zero** production `prisma.codingMessage` call
  sites outside `coding-data.service.ts`'s legacy branch — and that branch deleted in
  the same PR (`grep -c "prisma\.codingMessage" src --include=*.ts` must equal
  `0` for the merged build; the 62 test sites go with it).
- `grep -rn "coding_messages" src` returns **only** the migration + comments.
- `--verify` green, steps 3–4 gates green, one full soak release done.
- `prisma migrate diff` shows **only** the table drop — no column drift smuggled in
  (the tree has 136 migration directories; unrelated drift is the norm here, so diff
  the plan rather than trusting `migrate dev`).

**Rollback.** **None in code — this is the point of no return.** Recovery is a
database restore to the pre-migration snapshot. Because of that, this step's real
safety mechanism is *one release of `TRANSCRIPT_READ=legacy` availability before it*
(step 3), not anything inside it. Treat a failed post-drop verification as a restore
decision for the owner, not a forward-fix.

### Step 6 — `ChatCodingState → ChatWorkspaceState` (Prisma-level rename only)
**Change.** Rename the model + the 111 call sites / 43 files to
`chatWorkspaceState`. **`@@map("coding_sessions")` stays** (`schema.prisma:855`) —
per `ONE_SESSION_PLATFORM.md:232` the physical rename comes later, if ever.
`getChatCapability` (`coding-data.service.ts`, the `ChatCapability` block) is the natural single read
seam; `ChatCodingState.projectId` is *not* touched here (that is the archived folder
rename, explicitly out of scope).

**Gate.** `npx tsc --noEmit` clean; the satellite-lookup suites
(`crossmodel.service.test.ts:250-333` move rules, `coding-data.service.test.ts`)
green; a runtime smoke that a chat's capability DTO is unchanged
(`crossmodel.controller.ts:858` P5-B capability read).

**Rollback.** Revert the PR. No data movement, so a revert is complete — the table
name never changed.

### Step 7 — `CodingSchedule → ChatSchedule` (Prisma-level rename only)
**Change.** Rename the model + its references. **`@@map("coding_schedules")` stays**
(`schema.prisma:1548`). Firing logic (`schedule.service.ts:4454` / `:4563`) already
dispatches per profile — assert it, don't rewrite it.

**Gate.** The schedule suites green; a scheduled firing on a **satellite-less** chat
takes `startDetachedChatRun` and a firing on a satellite chat takes
`startScheduledRun` (the two branches at `:4454`/`:4563` are the assertion targets).

**Rollback.** Revert the PR; no data movement.

---

## 3. Blue-green overlap requirement (explicit)

Applies to steps 3–5. Two runtime facts force it:

1. **The flags are read per call, not per boot.** `transcriptDualWriteEnabled()`
   (`coding-data.service.ts:947-949`) and `transcriptReadMode()` (`:952-954`) are
   plain `process.env` reads inside the hot path, so a fleet mid-flip can have one
   color reading `merged` and the other `legacy` **in the same second**.
2. **Both colors serve the same chats.** The SSE mirror is Redis-mediated across
   instances (`chat-agent/run-event-mirror.ts`), so a viewer can attach on either
   color at any time.

The operative rule during overlap: **dual-write ON on both colors, for the entire
window, until the drop migration is fully deployed on both colors.** Writing to both
tables is what makes "whichever table this color reads" a safe question.

For the drop itself, order is: deploy the code that no longer *reads* the table
(step 1) on both colors → deploy the sticky switch (step 3) on both colors → soak
(step 4) → only then the migration (step 5). A migration that lands while one color
still ships code reading the dropped table is an outage with a 5-minute fuse.

---

## 4. The ONE thing most likely to break — and how it is detected

**The `agent_events` retention `complete` tier, via `FINAL_MESSAGE_LATERAL`
(`agent-events-retention.service.ts:288`).**

Why this and not the drop itself: the drop is *loud*. A missed `codingMessage` read
throws `P2021 table does not exist` on first use, in-process, within minutes — the
verify chain and the first smoke turn catch it. `FINAL_MESSAGE_LATERAL` is the
opposite shape:

```sql
SELECT cm.id FROM coding_messages cm
WHERE cm."sessionId" = r."sessionId" AND cm.role = 'assistant' AND cm.parts IS NOT NULL
  AND cm."createdAt" >= r."createdAt" AND cm."createdAt" <= COALESCE(r."finishedAt", r."updatedAt") + interval '10 minutes'
ORDER BY cm."createdAt" DESC LIMIT 1
```

It is a `CROSS JOIN LATERAL` feeding an `UPDATE … WHERE … AND m.id IS NOT NULL`
shaped statement, inside a `DELETE`/`STRIP` family that **reports rows and bytes**.

**The mechanism, measured not assumed.** After the drop the statement raises
`42P01 relation "coding_messages" does not exist`. `compactRange` is documented
*"Throws on a statement failure (the caller retries the range next tick)"*
(`agent-events-retention.service.ts:334`). The caller catches it at `:398`, counts a
failure, and **retries the same range** — until `COMPACTION_MAX_RANGE_FAILURES` is
reached, at which point it gives up on that range and **moves the cursor past it with
only a `logger.warn`** (`:403`: `passing over ids [lo, hi) after N failed tick(s)`).
`failures` is then reset to 0 at `:406` and the cursor advances, so **every subsequent
range fails the same way and is skipped the same way**. The net effect is identical to
the NULL case — the `complete` tier's parts-stripping statement never runs for any
range, so `agent_events.payload->'parts'` is never stripped — but the reason is a
*silently swallowed* `42P01`, not a quietly-empty lateral. Either wording makes the
tier report `rows = 0`, **which is the same value it legitimately reports on a quiet
fleet. The failure is silent, and its symptom is not a red test: it is
`agent_events.payload->'parts'` never being stripped, i.e. unbounded transcript growth
in the largest table, which surfaces as disk growth weeks later on a box that already
runs disk alerts.** The `logger.warn` at `:403` is the one observable trace, and it is
a warn line in a compaction tick nobody pages on.

**Detection — three independent probes, all cheap:**
1. **Pre-drop (best):** the Step 1 gate asserts the lateral resolves a **mirror-only**
   fixture (`COUNT(*) > 0`). This is the test that must be written in step 1, and it
   fails on today's tree.
2. **Post-drop, per-window:** alert on the `complete` tier reporting `rows = 0`
   across a rolling window **while** `SELECT count(*) FROM agent_events WHERE
   type='complete' AND octet_length((payload->'parts')::text) > <threshold>` is
   non-zero. That conjunction is the signature; either side alone is benign.
3. **Post-drop, structural:** `grep -rn "FINAL_MESSAGE_LATERAL" -A6` must name
   `crossmodel_messages` — a one-line assertion in the retention suite so a future
   edit cannot silently revert it.

**Runner-up, and the one most likely to break *at runtime* rather than silently:
the attach precedence at `crossmodel.controller.ts:569`** (§5, hazard A). Name it in
the PR body of whichever step touches routing, but it is a *mixed-profile attach*
defect that this plan does not introduce — it exists today, because
`streamChatRun` sends **every** satellite chat to the coding durable log (`:569-571`)
**before** it ever consults the cross-instance chat-busy mirror (`:575-580`), which is
therefore unreachable for satellite chats. Detect it with a mixed-profile replay: a
satellite chat that last ran an *escalation* (chat profile — escalations never route
to coding, `:1645`) must not attach to a coding replay.

---

## 5. Per-message profile: what already works, what breaks

The routing rule is implemented and stated in one place
(`coding-data.service.ts:649-660`): *a turn runs the coding profile iff the chat has
the satellite; `codeCapable` alone gates only attach triggers.* That is genuinely
per-message. The residue is everything that still asks **per chat**:

| # | path | keys on | under per-message profile |
|---|---|---|---|
| 1 | `GET /chats/:id/stream` attach (`crossmodel.controller.ts:492-589`) | in-process run key (`live-runs.ts:105-121`) → **satellite** `:569` → chat-busy Redis `:575` | **BREAKS both ways (hazard A)** |
| 2 | `?message=` back-compat start (`crossmodel.controller.ts:534-538`; gate `codeCapable` at **`:535`**, start at **`:537`**) | `codeCapable` | **BOUNDARY** — one GET lazily attaches the satellite (`coding-stream.controller.ts:592`), permanently converting the chat |
| 3 | `GET /stream` send (`:1641-1677`) | satellite `:1670-1674` | already per-message; but a satellite-less chat outside a workspace folder can never route coding (`codeCapable:false`, `coding-data.service.ts`, `capabilityFrom`) |
| 4 | `POST /coding/sessions/:id/run` (`coding.routes.ts:31`) | satellite (404 without it) | keeps working as the explicit coding entry |
| 5 | Stop/steer | plain stop → `chatRunKey` + `cm:liverun:`; coding stop → `agent_runs` | **BREAKS (hazard B)** — each stop path sees only its own run class |
| 6 | Busy gates | coding = `agent_runs` (`run-state.ts:694-702`); chat = Redis claim (`chat-agent.service.ts:633`) | **BREAKS (hazard C)** — two independent locks, see below |
| 7 | Queue drain (`chat-agent.service.ts:1183`) | `pendingChatMessage.mode` = the **chat-agent level** captured at enqueue (`schema.prisma:366`, comment: "resolved chat-agent level captured at enqueue time") — *not* patience | **BREAKS (hazard D)** — a queued message always drains as a chat-profile run |
| 8 | Guest stream (`:413`) | chat run key | keeps working (guests never code) |
| 9 | Sidebar `GET /chats/events` (`:709`) | nothing mode-related | keeps working |

**Hazard C verified, not inherited.** The explorer report offered this as unverified;
this run settles it: **every `agentRun.create` in the tree is in `coding/*`**
(`run-state.ts:134`, `:681`, `coding-stream.controller.ts:1234`,
`schedule.service.ts:2445`), and `chat-agent/*` only **reads** `agent_runs`
(`chat-busy.ts:201, 235, 269`). Therefore a coding run's lock is `agent_runs` and a
chat run's lock is the Redis claim — they do not see each other, and a coding start
during a live chat run is gated by neither. Today that is masked because routing is
effectively one-profile-per-chat; making the profile genuinely per-message makes it
reachable.

**None of §5 is in scope for the drop.** Hazards A–D are pre-existing and belong to
the per-message routing hardening, not to the transcript merge. Recording them here
is the point — the charter's third gate ("no session enters a stream path its
capability does not grant") cannot be asserted green until hazard A is fixed.

---

## 6. Doc surfaces this plan invalidates

- `DIGBY_PLATFORM_UNIFICATION_PLAN.md:3-9` — archived banner says the P5 remainder is
  "NOT planned"; this doc re-opens one seam. Reconcile the banner when step 3 merges.
- `DIGBY_PLATFORM_UNIFICATION_PLAN.md:210` — "`mode='code'` persists as the routing
  marker until Option 3's transcript merge" is **already false** (retired by
  `8b47928d55`); fix at next touch.
- `DIGBY_PLATFORM_UNIFICATION_PLAN.md:249, 255` — the drop instruction and the
  "guard is deleted" sentence: the drop is still ahead, the guard is behind.
- `ONE_SESSION_PLATFORM.md:212-217` (P3) and `:218-228` (P4) — the P3 list is
  steps 1–5 here; P4 items 1–2 are *not* in this plan (UI copy + home folder).
- `backend/.env.example:24-29` — `TRANSCRIPT_DUAL_WRITE` / `TRANSCRIPT_READ` are the
  two live rollback levers; they must stay documented until step 5 removes the second.

---

## 7. What this doc does NOT do

- It does **not** run a migration, touch production, or toggle a flag.
- It does **not** plan the physical rename `crossmodel_projects → folders`, the model
  `Folder`, or `ChatCodingState.projectId → folderId` — archived out of the plan
  2026-09-28 (`DIGBY_PLATFORM_UNIFICATION_PLAN.md:3-9`).
- It does **not** merge the execution tiers (`2fd4416a`: "research verdict never
  C"), and it adds no new guardrail (`ONE_SESSION_PLATFORM.md`: "no new guardrails" —
  autonomy friction stays at the confirmation-card model).
- It does **not** fix hazards A–D (§5); they are named, cited, and left to the
  routing step that owns them.