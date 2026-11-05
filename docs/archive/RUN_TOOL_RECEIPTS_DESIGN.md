# Run Tool Receipts — Design (evidence channel for the anti-confabulation stack)

> Status: IMPLEMENTED — PR1 (2026-08-24): schema + `run_tool_receipts` migration,
> the `run-receipts.ts` leaf + prisma service, the agent.ts recording seam,
> run-executor wiring (runId + in-process∪DB receipt union), guard rewiring
> (claim→receipt resolution with the legacy parts path as fallback) + the
> forgery layer, and verifier/chat-agent consumption. Follow-ups remain in
> "Follow-up PR (not PR1)" below.
> Motivation: the evidence guard + action verifier parse the model's own text —
> regex-on-claims catches roughly a third of fabrications, and models have learned to
> imitate the harness's own footers. SOTA direction (NabaOS-style): the harness records
> signed/append-only tool-execution receipts; verification resolves receipt data and
> re-queries primary sources instead of trusting prose. Deterministic layers convict;
> LLM layers only audit.
>
> Two corrections to the original brief, verified against the code:
> 1. The guard is not purely pattern-matching today — `run-evidence-guard.ts` layer 3
>    (`verifyPrClaims`) already does best-effort networked GitHub re-query; the real
>    constraint is "no direct prisma/env/LLM imports; deterministic layers stay pure."
> 2. `platform/executed-actions.ts` is a MODULE, not a table — reuse means reusing its
>    parsing, not its storage. `run_journal_entries` is the wrong shape (per-run
>    LLM-distilled prose injected into prompts; receipts must never enter a prompt).
> 3. Bonus hole this closes: `claimHasEvidence` counts a `tool_call` NAME as evidence —
>    a `git_push` that returned "git push failed" still exonerates a push claim, and a
>    confirmation-STAGED platform call counts as executed. Receipts carry `ok`.

> **Update 2026-09-25 (WI-K):** a confirmation-STAGED call now mints an `ok:false`
> row whose `ids` carry `{staged:true, confirmationId}` so `get_run_receipts`
> shows a lane parked on a card (before this a staged call left NO row while the
> tool's note claimed "ok=false rows were staged"). The invariant above is
> unchanged — every evidence reader filters `ok:true`, the fleet guard tile
> excludes `ids.staged` rows (by a null-safe `NOT (ids @> '{"staged":true}')`
> containment predicate — the Prisma JSON-path `NOT: {path:['staged'], equals:true}`
> filter compiles to `NOT (NULL = 'true')` for every row without the key and
> DROPS it, review 2026-09-25), and the staged envelope still never carries the
> receipt id. Kill switch `STAGED_CALL_RECEIPTS_DISABLED=1`.
>
> **Second writer (review 2026-09-25):** the owner's Confirm click on a staged
> card (`confirmations.controller.ts postConfirmationConfirm`) executes the
> stored args OUTSIDE the agent loop, so it used to leave no row — the staged
> `ok:false {staged:true}` row stayed the last word and read as "still parked"
> forever. The card execution now mints the row the loop would have: ok per the
> tool's own envelope (a thrown execution → `ok:false`), `runId:null`,
> `ids.confirmationId` = the card, `ids.ownerConfirmed:true`. Rows are
> point-in-time and never updated; a reader pairs a staged row with its
> execution by `confirmationId`. Kill switch `CONFIRMED_CARD_RECEIPTS_DISABLED=1`.

## Concept

One recording seam in the agent loop captures every consequential tool execution as a
structured, harness-written receipt (tool, ok, ids, input/output hashes, timestamp).
Receipts ride the existing `input.usage`-style per-run collector (shared with worker
subagents via the delegate spread) AND persist to a new `run_tool_receipts` table.
The evidence guard switches its conviction basis from text-regex to claim→receipt
resolution (legacy text path demoted to fallback), and gains a forgery layer for
harness-footer mimicry.

## Schema (new table, modeled on the run-journal migration)

```prisma
model RunToolReceipt {
  id         String   @id              // generated in-process (crypto.randomUUID)
  chatId     String
  runId      String?                   // soft ref to agent_runs.id; all attempts share it
  tool       String
  ok         Boolean                   // actually executed (not staged, not errored)
  ids        Json     @default("{}")   // { prNumber?, sha?, branch?, chatId?, scheduleId?,
                                       //   ticketId?, sessionId?, passed?, failedStage? }
  inputHash  String?
  outputHash String?
  createdAt  DateTime @default(now())
  chat       CrossModelChat @relation(fields: [chatId], references: [id], onDelete: Cascade)
  @@index([runId])
  @@index([chatId, createdAt])
  @@map("run_tool_receipts")
}
```

Migration hand-written via `prisma migrate diff` (no local DB), mirroring
`20260816000000_add_run_journal_entries/migration.sql`.

## Receipted tools (PR1 — minimal set)

`send_chat_message, start_coding_session, schedule_message, update_schedule,
cancel_schedule, dispatch_platform_task, file_feedback` (== TRACKED_CONSEQUENTIAL_TOOLS
as of PR1; the two sets have since DIVERGED by design — email tools
`gmail_send_email`/`send_email_as_digby` joined TRACKED_CONSEQUENTIAL_TOOLS
ticket 169846b6, 2026-09-27, WITHOUT minting receipts: their `{ok}` envelopes
parse through the parts lane; see executed-actions.ts for the canonical list),
plus `git_commit, git_push, open_pull_request, verify, run_command`
(`run_command` required for parity: it evidences deploy/probe claims today — honest
`gh pr merge` CLI flows must not be convicted).

Extraction (pure/deterministic — result strings are harness-authored formats):
- Platform tools: parse `toolResultEnvelope` JSON; `needsConfirmation:true` → NO receipt
  (staged ≠ executed). `file_feedback`: the two prose patterns already catalogued in
  `executed-actions.ts` (it never adopted the envelope).
- `git_commit`: ok iff `/\[[\w./-]+ ([0-9a-f]{7,40})\]/` → `ids.sha`.
- `git_push`: ok iff result starts `"Pushed "` → `ids.branch` (sha capture = follow-up).
- `open_pull_request`: ok iff `/^Opened PR #(\d+): (\S+)/` → `ids.prNumber, ids.url`.
- `verify`: always ok; `ids.passed`, `ids.failedStage` carry the verdict.
- `run_command`: ok on return; `ok:false` on the hard-timeout abort string.

## New modules

- `coding/run-receipts.ts` — DEPENDENCY-FREE leaf (like `executed-actions.ts`):
  `ToolReceipt`, `RECEIPT_TOOLS`, `extractReceipt(tool, args, result, now)`,
  `receiptMatchesClaim(claim, receipts)` (id claims prefix-match ≥8 chars, per the
  verifier's M1 rule; coarse kinds accept any `ok` receipt in the external-action class),
  `sha256()` helper. Reuse `executed-actions.ts`'s envelope parsing (export its
  module-private `parseResult`) — one parsing home.
- `coding/run-receipts.service.ts` — prisma side: `recordRunReceiptAsync()`
  (fire-and-forget, `.catch(() => {})`, NEVER throws), `getRunReceipts(runId)`
  (degrades to `[]`).

## Wiring

- `agent.ts`: `AgentRunInput` gains `runId?` + `receipts?: ToolReceipt[]` (shared
  collector, same idiom as `usage`); after each `tool_result` part is pushed, if
  `RECEIPT_TOOLS.has(name)` and not an `anon-` session (FK safety), extract → push to
  collector + `recordRunReceiptAsync`. Workers inherit the collector via the delegate
  spread — subagent receipts land in the parent's set, replacing today's blanket
  "delegate evidences everything" rule with the worker's actual executions.
  `AgentRunResult` gains `receipts?`. NO result-text/prompt/ToolContext changes —
  zero new imitation surface for the model.
- `run-executor.ts`: pass `runId: claimed.id`; before the guard call, union in-process
  receipts with prior attempts' DB rows (dedupe by id; in-process-first avoids racing
  the fire-and-forget inserts; DB union covers resumed runs — same `agent_runs` row
  across attempts).

## Guard changes (`run-evidence-guard.ts`)

- `applyCompletionClaimGuard` opts gain `receipts?: ToolReceipt[]` (type-only import).
  When provided: `unproven = claims.filter(c => !receiptMatchesClaim(c, receipts))`.
  When absent: legacy `findUnprovenClaims` path unchanged (keeps the existing ~970-line
  test file green). Claim-extraction regexes and the layer-3 GitHub re-query stay —
  extraction is unavoidable, layer 3 remains the exoneration lane for honest gh-CLI flows.
- NEW forgery layer: scan the original final for harness-only markers
  (`🔍 Harness claim verification (verified-at`, the `[HARNESS EVIDENCE GUARD — …
  REPLACED]` banner, `--- BEGIN UNVERIFIED RUN OUTPUT`) → `verdict.forgedFooter = true`.
  Not the bare `[HARNESS EVIDENCE GUARD]` prefix (legit in quoted journal strings).
  `GuardVerdict`/`verdictHasFindings`/`summarizeGuardVerdict`/journal entry gain the
  field; the existing replace lane (`renderSuppressedFinal`) is reused unchanged.

## Verifier / supervisor consumption

`verifyRunActionClaimsAsync` input gains `receipts?`; when provided, the execution pool
is built from receipts mapped into the `ExecutedAction` shape instead of parsing parts
(fallback kept). `chat-agent.service.ts` passes `result.receipts`. Chat-run executions
write receipts through the same seam (runId null) — the durable cross-wake query surface
exists from day one; wiring that query in is follow-up.

## Tests (verify chain: tsc → lint → full jest, `set -o pipefail`)

- NEW `run-receipts.test.ts`: extractor per tool class + matchers (no mocks needed).
- `run-evidence-guard.test.ts`: receipts provided (match → clean; empty set → convict;
  `ok:false` push does NOT evidence a push claim — the hole-fix pin); forged-footer
  markers; legacy no-receipts path pinned.
- `run-executor.test.ts`: mock `./run-receipts.service` at the boundary (same pattern as
  the run-journal mock); assert runId passthrough + receipt union/dedupe.
- `action-verifier.test.ts`: receipt exoneration, phantom conviction, parts fallback.
- `run-journal.service.test.ts`: forgedFooter failure line.

## Risks / edges

Fire-and-forget write race (guard reads the in-process collector — no timing dependence);
interrupted/cold-retried runs (DB union by shared runId); delegate workers (shared
collector); anon chats (skipped at the seam); envelope `ids` with non-id values (≥8-char
rule); false positive when a run quotes a prior replaced final verbatim (acceptable —
that behavior is what's being suppressed); volume bounded by maxSteps (retention sweep =
follow-up).

## PR sequencing

1. Schema + migration → 2. `run-receipts.ts` leaf + service + tests → 3. `agent.ts` seam
   → 4. executor wiring → 5. guard rewiring + forgery layer + journal field →
   6. verifier consumption → 7. full verify chain + live-DB verification per the standing
   owner directive.

## Follow-up PR (not PR1)

- ~~Citable receipt ids~~ — DONE (2026-08-24, PR-sized): push sha capture via
  `git rev-parse HEAD` appended to the `Pushed <branch> …` result (commit shas
  already came from git's stdout); `receiptId` threaded through ToolContext and
  embedded in the platform toolResultEnvelope (agent.ts generates the id BEFORE
  dispatch — staged calls embed nothing, so a cited id always resolves or
  convicts); the guard's pinpoint layer resolves full-uuid receipt citations
  against the receipt set (known → explicit evidence for the citing line's
  claims; unknown → forgedFooter conviction). STILL OPEN from that item: the
  "cite receipt ids" PROMPT discipline (agent.ts system prompt) — deliberately
  not landed here; prompting the model to cite receipts before prod receipts
  exist would just train phantom citations.
- ~~Verifier cross-wake exoneration from `run_tool_receipts`~~ — DONE
  (2026-08-24): `getRecentChatReceipts(chatId, 24h)` (ok-only, oldest-first,
  cap 500) + a pre-conviction tier in `verifyRunActionClaimsAsync` that re-runs
  the deterministic matcher with the chat's PRIOR receipts appended to the
  pool, anchored on `runStartedAt` (a receipt created after the run started
  would be the claim causing its own evidence; chat-agent passes the turn
  start). NOTE: the parts fallback is NOT retired — it stays the lowest tier
  for non-receipt callers by design.
- ~~Wider primary-source re-query (push claims)~~ — DONE (2026-08-24): guard 2b
  re-queries the GitHub COMMITS API (`GET /repos/{o}/{r}/commits/{sha}`) for the
  distinct union of claim shas + receipt-carried shas (cap 5, 8 s per sha, the
  verifyPrClaims discipline — never throws, silent on infra failure). Claim-sha
  404 → new `fabricatedShas` verdict lane (wired through verdictHasFindings /
  summarizeGuardVerdict / the journal verdict row / the integrity ticket);
  receipt-only sha 404 → soft caution line (amended history), never a
  conviction. STILL OPEN from that item: `git ls-remote` branch-existence
  checks and `citedArtifactExists`-style DB checks for platform-artifact claims.
- ~~Receipts in Management UI~~ — DONE (2026-08-24): the fleet-pulse guard block
  carries a `receipts` rollup (24h total / failed / top-3 tools, two grouped
  COUNT queries, field omitted on any DB error) and the Dashboard guard tile
  renders one compact "receipts 24h: N (M failed) · top tools" line, hidden
  when the field is absent. STILL OPEN from that item: receipts in supervisor
  STATE (the supervisor state doc — a bigger design call about what the
  supervisor should see vs. what operators see).
- ~~Retention sweep~~ — DONE (2026-08-24): run-reaper rule (d) deletes
  `run_tool_receipts` > 30d old, 5k/pass, createdAt-only (runId is a soft ref;
  chat-run receipts carry null).
- ~~`set_chat_autonomy` + goal/todo receipts~~ — DONE (2026-08-24): RECEIPT_TOOLS
  covers set_chat_autonomy (both prose shapes + staged gate) and
  goal_create/goal_update/todo_create/todo_update (prose-create ids / bare
  entity-JSON updates). Skipped as out of the named scope: hook_* mutations,
  update_supervisor_state, and the org mutations (create_chat/move_chat/…).
