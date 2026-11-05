# Prompt: remediate the Digby coding-autonomy framework and the CanLaw program, phase by phase

You are a Claude Fable agent working in `example-org/crossmodel` (Digby). Your job
is to fix the coding-autonomy framework defects and the CanLaw project-level
defects listed below, **one phase at a time**: implement, test, merge to `main`,
watch the deploy, verify in production against live data, record the
verification, then start the next phase. Do not skip verification. Do not
start a phase while the previous phase's post-deploy check is open.

Everything in this prompt was established by a live-data audit on 2026-09-08
(production database dump, ten lane transcripts, the Fleet Supervisor record,
both program repos, the checkpoint bucket). The full evidence is in
`docs/CANLAW_DIGBY_REVIEW_2026-09-08.md` on branch
`claude/canlaw-digby-review-44sy50` (read §0, §4, §5, §6 first). Bug ids below
(B1–B14, L1–L24) are that document's ids. Do **not** merge that branch's commit
34d1bc84 (a read-only prod probe playbook) into `main`.

---

## 0. Rules of engagement

1. **Read first:** `AGENTS.md` (canonical), `CLAUDE.md`, `memory-bank/*`, the
   review doc above, and `docs/REMOTE_OPS.md`. Where AGENTS.md and this prompt
   disagree on process, AGENTS.md wins; where they disagree on what is broken,
   this prompt's evidence wins until you re-probe and find otherwise.
2. **Deploy discipline (standing owner directive):** develop on a branch,
   `tsc` clean on changed files, unit tests green, merge to `main`, push. The
   push runs the CI test gate and then the blue-green deploy (A first, owns
   migrations; B; then box C via the extra-hosts step). Never add box C to
   `EC2_HOSTS`. Never use `docker-compose.yml`. Watch `gh run list` until the
   deploy is green, then verify in prod. Code, docs and memory-bank updates go
   in **one** commit. Never rebase a branch with merge history; verify pushes by
   ancestry, not by exit code.
3. **Reading production is allowed, writing it is not** except through
   migrations shipped by the deploy. From a Mac session with the prod key:
   `ssh -n -i ~/.ssh/crossmodel-prod.pem ubuntu@203.0.113.10 '...'`, then
   `BE_URL=$(sudo docker exec admin-worker-<colour> sh -c 'printf %s "$DATABASE_URL"')`
   and `sudo docker run --rm -i pgvector/pgvector:pg16 psql "$BE_URL" -c "..."`.
   Find the live colour with `sudo docker ps` first (it flips on every deploy).
   From a cloud session, use the `ec2-ops` workflow (push a commit touching
   `scripts/ec2-ops/**`; one-shots go at the anchors; verify the `== NAME ==`
   header in the run log). Redact secrets before output leaves the box.
4. **Do not touch the CanLaw training fleet** (Nebius nodes cyan, olive,
   magenta, aqua), the S3 checkpoint bucket, or any lane's stored schedule
   prompt without backing the prompt up first. Phase 10 items that need an
   owner decision are marked; ask once, with a default and a deadline.
5. **Every phase ends with a written verification record** appended to
   `docs/AUTONOMY_REMEDIATION_LOG.md` (create it in Phase 0): what shipped
   (commits, PRs, deploy run id), the prod probe you ran, the numbers before
   and after, and the exit criterion met. If a criterion is not met, say so
   and either fix forward in the same phase or roll back with
   `/opt/crossmodel/rollback.sh` and record why.
6. **Model behaviour is not fixed by prompt text alone.** Several of these
   defects have already received prompt "steers" (rules 8 and 9 on the
   Post-CPT lane, the supervisor's claim-free rule, AGENTS.md anti-patterns)
   and recurred. Prefer harness-enforced changes: schema, executor checks,
   deterministic filters. Where a prompt change is part of the fix, pair it
   with a metric that proves it took.

---

## 1. What is wrong: the framework

Numbers are from 2026-09-02 → 09-08 unless stated.

### A. Monitoring is done by LLM polling, and most of it is waste
- 67% of the $1,305 spent on the CanLaw and bench lanes in seven days went to
  ticks whose own journal says "nothing changed". Path C ran two hourly
  monitors plus self-re-arming one-shot chains (267 schedule-origin runs in
  six days, three monitors live at once on 09-03). The Post-CPT lane ran 113
  consecutive hourly ticks confirming the same dependency wait. The serve
  lane polled a non-existent S3 prefix 134 times over 69 hours.
- **L2** Hook `14b0e46a` (serve lane `run_completed` → eval lane, debounce
  3,600 s) has a time-only filter; it woke the eval lane 80 times for zero
  deliverables and re-woke the supervisor after each.
- **L8** 43 of 45 `[HARNESS CONTINUATION rN/3]` one-shots ended
  `skipped:obsolete`: on a monitored lane the monitor always pre-empts them.
- `skipped:busy` re-arms every 3 minutes; a 9m57s start lag was observed;
  35 distinct workers served one lane's 281 runs.

### B. Schedules: the renewal model is emulated by prompts, badly
- **L1** No harness successor concept. Lane prompts say "at 44/48 cancel and
  schedule_self a renewal", so three serve-lane links died at exactly 44/48
  and three Path C links at 25–26/48 (189 of 288 paid firings used, overlaps
  for a tick). The harness run-cap path (`lastStatus='expired'`) never fired
  on 530 rows; all 97 retirements were `cancel_schedule`.
- **L7** `cancel_schedule` writes no `disabledAt`; the digest infers stop time
  from `lastFiredAt`. **B2** That is how the 09-04 Project Pulse declared
  CanLaw BLOCKED for three "stopped" schedules that each had an enabled
  successor (fixed forward in c6a43c0c; the verdict was never re-evaluated and
  `memory-bank/crossmodel-activeContext.md:103,105` still records it as why
  SFT stalled).
- **B1** `update_schedule` succeeds on a disabled/terminal row and returns a
  next-run time (`coding/schedule.service.ts:728-760`).
- **B7** run-cap exhaustion is persisted as `expired`, same as lifetime expiry
  (`schedule.service.ts:1096-1097`). **B8** plain-chat lanes never receive the
  cap-skip notice (`consumeCapSkipNotice` only called from coding run paths).
- **B11** stopped-schedule fast lane is an unref'd 12-minute timer lost on
  deploy; the digest backstop only re-offers `expired`/`started` rows
  (`coding/stopped-schedule-alert.ts:222-236`; draft PR #634 exists).
- **L6** the 8,000-char schedule prompt cap surfaced as an owner card when a
  10,083-char prompt could not be renewed verbatim (`oq_daba2807`).
- **L23** a lane's only cadence can be cancelled with no replacement armed; the
  supervisor did this to the Post-CPT lane on 08-29 23:44Z, then closed its
  own "recreate" directive as obsolete on 08-30 06:01Z; the lane was silent
  30.7 h across the CPT finish. The `schedule_disabled` event now carries
  `remainingEnabled` and a "DEAF" warning, but nothing acts on it.

### C. Run output durability and the self-audit
- **L4** Only a run's last assistant turn is durable. On one lane six
  substantive outputs were overwritten by the closing self-audit table: two
  `[DISPATCH-NEEDED]` blocks (ticket `2ce29c32`, priority 2, open since
  08-31), the RL-theory answer to the owner, the design v2 and v2.2 texts,
  and the owner's 09-08 plain-English explainer. The lane then cited those
  rows as "durable" evidence for content they do not contain.
- **L4b** The post-run self-audit prompt asserts a false premise ("you marked
  every plan step complete") and forces an eight-row table on every run. The
  Post-CPT lane refuted the premise in 122 consecutive replies; the serve
  lane in 126. The supervisor's "claim-free tick" rule (1–2 lines when
  nothing changed) was honoured in 1 of ~95 eligible ticks because the
  mandatory audit turn overwrote the others. The template also hard-codes
  facts that go stale (a bench-bar message id).
- Output is audit-shaped: 499 "SELF-AUDIT PASSED" blocks and 668 "EXACT"
  stamps in one lane; the owner's replies were "i havent gotten an update in
  many hours", "i don't really understand just move forward".

### D. Evidence guard
- **L5** REPLACE mode destroyed a real tick's observations (09-07 17:31Z, a
  +159-minute EDT/UTC slip). 12 of 23 Path C clock strikes are ≤10 minutes
  of skew (ticket `80dd882d`). Three `commit_pushed` strikes on the Post-CPT
  lane, which has no code surface, were triggered by the word "committed" in
  "design document committed in chat".
- **B5** `run_command` receipts are `ok:false` on any non-zero exit, and any
  `ok` external-action receipt vouches for every probe/benchmark/deploy claim
  (`coding/run-receipts.ts:184, 257-285`; widened 09-08 by
  `RUN_COMMAND_NOT_OK_RE`). A lane observing a training box (a grep with no
  match, an ssh that exits 1) can cite nothing; one successful `git` call
  exonerates everything.
- Candidates (not yet re-derived): coding-lane guard lacks the cross-wake
  exoneration tier the chat lane has (`run-evidence-guard.ts:3054-3075`);
  GitHub verification runs twice per struck run (`agent.ts:1606-1615`).
- Since 09-08 the `zero_tool_prefinal` seam nudges tool-less finals; strike
  counts jumped (46 strikes on 8 Post-CPT runs in the following 8 hours).
  Measure whether that is signal or churn before tuning it.

### E. Owner interaction
- **L3** Lanes and the supervisor file permission asks for actions already
  authorized: three power-on cards for a node the lane could power itself
  (owner: "yes you do self power what are you talking about"; "i thought you
  could turn on cyan yourself"), plus a fourth on 09-08 19:02Z after v5 FAIL
  asking which fix path to take (owner: "YOU HAVE FULL AUTONOMY ... STOP
  STOPPING"). Four questions were filed twice, by a lane and the supervisor
  8–38 minutes apart. Median answer latency 2h47m, max 9h58m; ≈16 h of GPU
  gate delay on 09-07/08 from power-on asks alone. Nearly every owner answer
  in the window was a delegation or a challenge to the premise.
- Owner questions have no deadline and no default; expired cards vanish
  ("The card is gone; re-stage or re-ask").
- **L19** Autonomy grants are invisible to the lane they apply to: a grant
  created 09-07 16:42Z with no notice; the lane kept routing through the
  supervisor for 26 more ticks.

### F. The Fleet Supervisor
Net negative for the program over 08-29 → 09-08: ≈83 corroborated actions
against ≈55 phantom action claims, 156 verifier strikes, 21 platform tickets
about its fabrications, 14 action-wakes against 442 note-wakes.
- **B3 (root cause)** The state document is write-only and character-capped.
  Since 08-28 only the OPEN DIRECTIVES block is injected into wakes
  (≈5.5–6.4k chars, newest 10–20 entries). Every owner autonomy grant
  scrolled out within 4.5–24 h while the supervisor's own gating directive
  stayed. Of 50 register entries, 27 are owner-verbatim and 14 of those are
  questions or chit-chat held as open directives. Code:
  `platform/supervisor-state.service.ts:387` (`slice(-MAX_DIRECTIVES)`),
  `chat-agent/chat-agent.service.ts:1060-1062` (every owner message becomes a
  directive).
- **L20** From that stale view it issued four steers that re-imposed owner
  gates the owner had removed ("stop at pack-GREEN and ask the owner to power
  cyan"; "NEVER self-power any node"), costing ≈27–35 h on 09-06 → 09-08.
  Nothing checks a steer against standing grants.
- **L21** It converted a lane's pre-authorized `[DISPATCH-NEEDED]` into an
  owner approval card (8h43m late) and assigned a relay hop to a lane with no
  send grant.
- **B4** `update_supervisor_state` records dispatch ids with no existence
  check (`supervisor-state.service.ts:484-492, 527, 671-684`); 4 of 30 ledger
  ids exist nowhere else. **L24** Three "did NOT execute" refutations were
  false; the refutation path has no existence check either.
- **L22** The TRAIN_DONE `run_completed` reached it with a ~420-char summary
  head that hid the completion; no transcript pull followed (the 09-08 change
  that quotes the accepted final in the fleet digest is the fix class).
- **L17** Its hook template for the eval lane still said "s1-r2 smoke is
  pre-authorized" three days after round 2 was retired; the same state block
  is copied into four places.
- **B13** the 15-minute watchdog heal recreates the supervisor's wildcard hook
  but not its sweep schedule. **B14** it cannot hear its own cap-dropped wakes
  (self-loop suppressed). **B6** the hook depth cap drops all event types
  including alarms (`platform/hooks.service.ts:253`).

### G. Ops, observability, security
- **B10** `session-history-sync` returns a summary string instead of throwing;
  the cron stays `ok` while it fails `git push` to `example-org/canlaw.git`
  ("Repository not found / Authentication failed") every few minutes: 171 of
  the 200 newest app warnings on 09-08, 55 more in the next 8 h.
- **B9** the owner-briefing Redis lock is never released early when the
  utility LLM returns empty; briefings stop for the 90-minute window.
- **B12** `persistSessionEnv` deletes the env sidecar whenever `env.sh` is
  ENOENT (the 08-20 wipe class). **L12** `/tmp` on lanes (SSH key, Nebius CLI
  config) is wiped by every deploy; watchers killed; 4 runs lost their worker
  mid-run in six days.
- **L13** `agent_runs.startedAt` is NULL on 1,500/1,500 rows; spend is stored
  per day only; `tokensUsed=0` on guard rows; `run_journal` has no cost.
- **L9** Three API keys were printed into transcripts by lane audits (two on
  08-31, one via `pgrep -af`). No scrubber on `run_command` output.
- **L10** A serving teardown missed a root cron; the judge server relaunched
  and ran 7.3 h on a burned key. An eval endpoint was internet-reachable and
  probed by a scanner.
- **L11** Four unattributed IAM/S3 changes on the checkpoint bucket (09-01,
  09-03, 09-05, 09-06); no CloudTrail trail; several agents hold superadmin.
- **L14** Model derailment loops: ~130 placeholder `update_feedback` calls in
  one run; 750 `update_feedback` placeholder-id errors fleet-wide in 8 hours
  on 09-08/09; docs-keeper firing #30 failed after two compact-and-retry
  attempts; two runs killed by "request too large" provider rejections. A
  derailment breaker landed on `main` on 09-08 (2ecde991); confirm it is
  deployed and effective.
- Probe hygiene: six of ten SQL statements in a 09-07 health probe errored
  while the job passed; the diagnostics schedule view omits disabled rows.
- Other candidates: hooks debounce Redis gate not released on a zero-row
  claim (`hooks.service.ts:525-559`); daily-cap counter immortal if EXPIRE
  fails (`schedule.service.ts:835-836`); auto-mode child sessions inherit the
  full autonomy grant (`autonomy.service.ts:278-305`); pre-exec disk guard
  wipes the shared dev container's `/tmp` (`container.service.ts:170-174`);
  egress allowlist matches hostnames only (`egress-policy.ts:231-251`); stale
  cap docs (`AGENTS.md:536`, `schema.prisma:1196` say 288; code is 1440).

### H. Spend governance: none
No Digby surface knows the Nebius ($72.5k, 07-27 → 09-08, fleet-wide), Brev
($65.4k) or Fireworks bills; the program repo records no dollar figure for
CPT, SFT-1 or the smokes. Idle hardware went unnoticed (cyan ≈54 h running but
excluded from training ≈ $1,800; olive held ≈32 h).

---

## 2. What is wrong: the CanLaw program

- The full v0.8.1 eval (`addc2096`) has been held behind a dev gate no
  checkpoint can pass since 08-31. No SFT checkpoint has a board score. A
  full eval is ~80 minutes on one 8×B300 (~$44).
- The closure gate is decided by a **24-prompt probe** against a ≥99% bar:
  one prompt separates PASS from FAIL, and 24 samples cannot distinguish 96%
  from 99%. v5 (95.83%) and the in-flight v6 both hang on this.
- SFT-1 dev-gate scores collapsed from round 1 to round 8 (case outcome 81.7%
  → 39.4%, statute 76.0% → 48.9%) with no post-mortem; the program restarted
  from base with new data instead.
- The dev split is the bench's own scored gold for four tasks; the bench
  repo's decontamination doctrine says the bench is the "final, untouched
  cross-check". Needs an owner ruling before any SFT number is published.
- The only RL design in the repo argues "GSPO, not GRPO: for MoE models this
  is settled" and was written for Command A+; canlaw-1f is dense. Design
  v2.2 exists in one chat row and a todo title.
- The SFT-1 pack had one EOS token per ~4,367 masked tokens; the termination
  failure was predictable from the pack statistics before 5.5 days were
  spent.
- No recipe, budget, or code for the live line in the repo: no SFT masking,
  LR, epochs; the Fix-C patch and closure probe uncommitted; the runbook
  `.digby/notes/path-c-ops.md` that AGENTS.md points to has never been
  committed; the docs-keeper rewrites one run-on bullet in place.
- S3: 26.0 TB (≈$598/month) with 9.1 TB of never-pruned DiLoCo deltas, 1.1 TB
  of legacy rounds, ≈2.5 TB of duplicate copies; no restore drill; no
  CloudTrail.
- Bench (`canada-quant/canlegal-bench`): 21 in-house rows never re-scored on
  v0.8.1; the scorer label `qwen3.8-27b-semantic-v1` spans three backends
  with no recalibration; PRs #86, #88, #89 green and unmerged; CI red on 39%
  of runs because `tests/test_meta_json_consistency.py` pins `test_count`;
  PR #81 merged with checks pending; the Phase-6 dedupe deleted 105
  doctrine-v1 samples (GH #80); a 09-08 audit found half-credit counted as
  correct, answer clipping and wrong gold; committed build output and scratch
  files in the repo.
- Three leaked keys to rotate if not already; teardown checklist missing.

---

## 3. Approaches to borrow (the state of the art for these problem classes)

- **Deterministic sidecar monitoring, not LLM polling.** Kubernetes liveness
  and readiness probes, Airflow deferrable sensors, and durable-execution
  engines (Temporal, Prefect) all separate "is the job alive and how far is
  it" from "what should we do about it". The poller is code; the model is
  woken only on state change. Digby's equivalent is a `job_watch` primitive
  (Phase 7).
- **Idempotent, change-detected event delivery.** At-least-once delivery
  with idempotency keys and content hashing (the Stripe webhook model): a hook
  fires when the payload's declared state changed, not when a timer elapsed.
- **Append-only ledgers with event sourcing for supervisory state.** Never
  evict open items; derive the injected view from a query over first-class
  rows; pin standing rules outside any rolling window.
- **Capability-based authorization checked by the executor.** The model
  proposes; the harness compares the proposed ask or steer against standing
  grants and directives (policy-as-code, OPA style). A steer may never narrow
  a delegated authority; a pre-authorized action is executed, not asked.
- **Human-in-the-loop with SLAs and defaults.** Every decision request
  carries a deadline, a default action, and an escalation ladder (PagerDuty
  style: card → push → briefing headline → default). Expired cards resolve to
  the default and say so.
- **Circuit breakers and budgets for agent loops** (Hystrix pattern): a
  per-run tool-call budget, a repeated-identical-call breaker, and a
  max-tokens-per-tick ceiling, with the breaker's trip recorded as a metric.
- **Verifier as a filter, not a rewriter.** Tool-grounded citation: ids and
  timestamps in a final must come from the same run's tool results (build the
  citation table in the harness; constrained output for the ids). Annotate or
  reject-back with a fresh tool round; never replace a whole final over a
  clock-class finding.
- **Observability as spans.** One run = one span with start, queue wait, tool
  calls, tokens, cost, guard outcome (OpenTelemetry shape). Cost per run, not
  per day.
- **FinOps basics.** Cost allocation tags per goal/environment, budgets with
  alerts, idle-resource detection, weekly no-op-share reporting.
- **Secrets hygiene.** gitleaks-class regex scrubbing on every tool output
  before it enters a transcript; key rotation runbook; teardown checklist that
  removes cron/watchdogs before killing servers; default-deny ingress on eval
  endpoints.
- **ML program discipline.** Gates need statistical power (Wilson/binomial CI
  at the bar; ≥200 samples for a 99% bar); dev and test sets must be disjoint
  (checkpoint selection on dev only); every failed run gets a written
  post-mortem before the next launch; termination is trained with sequence
  packing that ends every record in EOS, an EOS-aware loss weight, and a
  measured EOS density; distributed low-communication training follows
  DiLoCo (Douillard et al., 2023) as already implemented; for RL, GSPO
  (Qwen team, 2025) is sequence-level importance weighting motivated by MoE
  routing instability, so the dense-model rationale must be re-argued or GRPO
  taken as primary; decontamination via n-gram overlap against the frozen
  manifest is standard and already present, keep it one-way.
- **Storage lifecycle.** S3 lifecycle rules (expire intermediate deltas after
  the next closed round; transition kept rounds to infrequent access);
  CloudTrail data events on the bucket; one restore drill per artifact class.

---

## 4. Phases

Each phase: **Goal → Changes → Tests → Merge + deploy → Post-deploy
verification (prod probe) → Exit criterion.** Keep each phase to one merged
PR (or a few small ones) so a rollback is one deploy.

### Phase 0 — Baseline, guardrails, and the log
Goal: reproducible before-numbers and a place to record after-numbers.
- Create `docs/AUTONOMY_REMEDIATION_LOG.md`. Record the baseline: per-lane
  7-day spend and no-op share (from `loop_metrics` + `run_journal_entries`),
  guard strike counts per lane and for the supervisor, owner-question
  latency and duplicate count, hook events per lane, schedule renewal pattern
  (`cancelled` at N/max), session-history-sync warning rate, count of
  `update_feedback` placeholder errors per hour.
- Add a standing **lane inventory** probe to `scripts/ec2-ops/diagnostics.sh`
  (chat, title, goal, enabled schedules with runs/max/next, disabled rows in
  the last 24 h with successor, last run, last journal outcome) and make
  `psql` errors fail the step. Include disabled schedule rows and join
  session titles.
- Populate `agent_runs.startedAt` (L13) and add `costUsd`/`tokensIn`/
  `tokensOut` to `run_journal_entries` or a per-run metrics row so cost per
  tick is readable.
- Fix the stale docs (`AGENTS.md:536`, `prisma/schema.prisma:1196` cap 288 →
  1440) and correct `memory-bank/crossmodel-activeContext.md:103,105`
  (the 09-04 BLOCKED verdict was false; B2).
Tests: unit for the new metrics writes; the diagnostics script runs clean.
Verify: run the probe once after deploy; the log's baseline table is filled
from it. Exit: baseline recorded; `startedAt` non-null on new runs.

### Phase 1 — Durable output and the self-audit (L4, L4b)
Goal: nothing the model says to the owner or to another lane is lost, and a
run that changed nothing can end in one line.
- Persist every assistant turn of a run (or at minimum every turn containing
  a `[DISPATCH-NEEDED]` block, a document heading, or a reply to an
  owner-origin message) as its own durable message; the final turn is no
  longer the only row.
- Move the post-run self-audit to `run_journal_entries` (a structured
  `selfAudit` field), not the chat. Remove the "every plan step complete"
  premise; the audit prompt states the actual plan counts. Allow a final
  answer of ≤2 lines when the run made no state change and journals it as
  `no_change`.
- Fix the fleet `run_completed` digest to carry the accepted final's
  milestone markers (TRAIN_DONE, GO/HOLD, PASS/FAIL, `[DISPATCH-NEEDED]`)
  ahead of the summary head (L22).
Tests: message persistence unit tests; a fixture run with a dispatch block
followed by an audit turn yields two durable rows; digest marker extraction.
Verify: after deploy, on the Post-CPT (`e083ff2e`) and Path C (`cec340f2`)
lanes, the next three ticks: durable final ≤ 2 lines when nothing changed;
audit present in the journal; no "premise correction" text. Exit: 3/3 ticks
comply on both lanes; ticket `2ce29c32` closed.

### Phase 2 — Schedules (L1, L6, L7, L23, B1, B2, B7, B8, B11)
Goal: the harness owns cadence lifecycle; prompts stop emulating it.
- Migration: `coding_schedules.disabledAt`, `disabledBy`, `disabledReason`,
  `successorId`; `lastStatus` gains `exhausted` (distinct from `expired`).
- `renewOnExhaust` boolean (default true for schedules on chats with an
  active goal): on `runsCount == maxRuns`, the harness arms an identical
  successor and links it; `maxRuns: null` allowed for goal-bearing lanes.
- `cancel_schedule`: if it would leave `remainingEnabled = 0` on a chat with
  an active goal or an in-flight external job, require an explicit
  `allowDeaf: true` and file an attention item; always stamp `disabledAt`.
- `update_schedule` refuses disabled/terminal rows unless `resume: true`
  (B1). Deliver cap-skip notices to plain chats (B8). Prompt-cap handling in
  the tool: reject with the exact overage and offer an auto-shortened prompt
  with a diff instead of failing (L6).
- Digest and stopped-schedule alert use `disabledAt` and `successorId`, not
  `lastFiredAt` inference (B2, B11); fold in draft PR #634.
- Harness continuation one-shots: skip creating one when the chat has an
  enabled recurring schedule that will fire within its interval (L8).
- Then, with the owner's knowledge, edit the stored prompts on `cec340f2`,
  `7fbd168c`, `e083ff2e` to remove the "cancel at 44/48 and renew" clauses
  (back them up to `docs/prompt-backups/` first).
Tests: unit for renewal, cancel guard, update refusal, status labels; digest
fixture with an exhausted link + successor produces no attention item.
Verify: over the next 48 h, zero `cancelled` rows at N/max on CanLaw lanes;
`exhausted` rows have successors; no false "stopped" attention items in
`project_digests`. Exit: those three checks pass in the lane-inventory probe.

### Phase 3 — Hooks and supervisor plumbing (L2, B6, B13, B14, L22)
Goal: hooks fire on change, alarms always get through, the supervisor's
heartbeat cannot silently die.
- Hook delivery keeps a `lastPayloadHash` per hook; `run_completed` fires
  only when the accepted final's hash or a declared state field changed;
  time debounce stays as a floor. Add an `idempotencyKey` to hook events.
- Depth cap: exempt `run_failed`, `attention_needed`, `schedule_disabled`,
  and owner-answer events from the cap (B6). Route the supervisor's own
  `schedule_cap_skipped` to an attention item instead of a suppressed
  self-loop (B14).
- Attention watchdog heal recreates the supervisor sweep schedule as well as
  its hook (B13).
- Hook `14b0e46a` (serve → eval) is re-created as change-gated or removed.
Tests: hash-gated delivery unit tests; depth-cap alarm exemption; heal
creates both rows on a fixture with neither.
Verify: eval lane `596102ca` hook-origin runs drop from ~25/day to the
number of real serve-lane state changes; supervisor sweep row present after
a forced delete in staging. Exit: eval-lane no-op wakes < 3/day for 3 days.

### Phase 4 — Owner questions and autonomy (L3, L19, L20, L21)
Goal: the harness refuses to ask the owner for what is already granted, and
every question that is asked has a clock.
- `PreAuthorizationService`: given a proposed owner question or supervisor
  steer, compare against (a) the chat's autonomy grant, (b) the owner's
  standing directives (Phase 5 rows), (c) the owner's last N owner-origin
  messages on the chat. If covered, return `execute` with the citation; the
  tool executes and journals instead of filing. A steer that narrows a
  standing grant is rejected with the citation (L20).
- `owner_questions`: add `deadlineAt`, `defaultAction`, `topicKey`,
  `dedupOf`. Dedup by `topicKey` within a window across lane + supervisor.
  Escalation: card → `notify_user` push at T-2h → briefing headline at T-1h →
  resolve to default at T with a visible "resolved by default" note. Expired
  cards never vanish.
- Announce autonomy grants as a system message in the target chat with the
  allowed tools (L19).
- Register lane `[DISPATCH-NEEDED]` blocks as structured `dispatch_requests`
  rows; the supervisor's tool for handling them offers exactly `execute` or
  `refuse(reason)`; converting to an owner card is not an option; the
  executor rejects a hop assigned to a chat without `send_chat_message`
  (L21).
Tests: pre-auth unit tests (covered / not covered / narrowing steer); dedup;
escalation timers; dispatch state machine.
Verify: for 7 days, count owner cards whose ask was covered by a standing
grant (target 0), duplicate pairs (target 0), median latency; confirm one
card resolved by default in staging. Exit: zero covered asks and zero
duplicates in the window.

### Phase 5 — Supervisor state (B3, B4, L17, L24)
Goal: the supervisor reads what the owner actually said, and its ledger
cannot contain ids that do not exist.
- Directives become first-class rows (`supervisor_directives`: text, source
  owner|self, status open|done|superseded, createdAt, closedAt, pinned).
  Owner questions and chit-chat are not directives (classify with a small
  deterministic rule plus the utility model; when unsure, store as `note`).
  Open owner directives are **never** evicted; the injected block is a
  query: all pinned + all open owner directives + newest N self-authored.
- Standing rules ("full autonomy", "self-power delegated", cost ceilings)
  are `pinned` and injected verbatim every wake.
- `update_supervisor_state`: existence-check every dispatch id, message id,
  schedule id and receipt id against the database before recording; reject
  the merge with the list of unknown ids (B4). Same check on refutations
  (L24).
- Note skeleton: the harness pre-fills the wake with the deterministic digest
  facts (lanes, schedules, last runs) and the model annotates; ids in the
  final must appear in that skeleton or in a same-run tool result.
- Hook templates and schedule prompts that carry program state get a
  `stateRef` to one source row instead of copied text (L17).
Tests: eviction never drops open owner rows; classifier fixtures; merge
rejects unknown ids; injected block contains pinned rules on a fixture with
60 self notes.
Verify: for 7 days, supervisor guard strikes/week (baseline 144–156) and
phantom-id strikes; count of owner-verbatim rows that are questions (target
0); confirm the standing autonomy rule appears in every wake prompt via a
prod probe of `supervisor_states`. Exit: strikes down by half, zero phantom
ids, standing rules present in 100% of sampled wakes.

### Phase 6 — Evidence guard (L5, B5, candidates)
Goal: the guard filters fabrication without destroying observations.
- Clock class: tolerance ≥15 min; annotate the offending line and journal it;
  never REPLACE a whole final for a clock finding. `commit_pushed` scoped to
  chats with a code surface (a repo binding or a `git_*` receipt this run).
- Receipts: add an `observation` receipt class for `run_command` that stores
  exit code, stdout/stderr head and duration; non-zero exit does not make it
  `ok:false` for exoneration of an observation claim (it does for a
  completion claim). Only an `ok` receipt of the matching class exonerates
  the matching claim class (probe ↔ observation, deploy ↔ deploy receipt,
  PR ↔ GitHub verification) (B5).
- Coding-lane guard gets the cross-wake exoneration tier the chat lane has;
  GitHub verification result is reused between in-loop reject-back and
  finalize.
- Tune `zero_tool_prefinal`: nudge once per run, then allow a one-line
  no-change final (Phase 1) rather than repeated nudges.
Tests: guard fixtures for each class; regression test for the 09-07 17:31Z
replacement (must annotate, not replace).
Verify: 7-day strike composition per lane (clock-skew strikes → 0; REPLACE
events → 0; strikes per run on Post-CPT back below 10%). Exit: those three
numbers.

### Phase 7 — External job watch (the new primitive)
Goal: lanes stop polling; the harness watches jobs deterministically.
- `job_watches` table: owner chat, goal, target (ssh host + command, or S3
  prefix + expected object count, or HTTP health URL), progress regex or
  JSON path, stall timeout, expected completion marker, cost per hour,
  poll interval, status. A worker cron polls, writes an `observation` receipt
  per poll, updates `lastProgress`, and emits `job_progress`, `job_stalled`,
  `job_done`, `job_preempted`, `job_cost_threshold` hook events to the owner
  chat (and the supervisor via the wildcard hook).
- Platform tools `create_job_watch`, `update_job_watch`, `close_job_watch`;
  UI list on the project page; digest shows job liveness and cost to date.
- Migrate: Path C's hourly monitors, the serve lane's S3 gate polling, the
  eval lane's hook wake, and the Post-CPT lane's hourly tick become job
  watches plus event-driven wakes with a 3–4 h heartbeat.
Tests: poller unit tests with fake targets; stall and preemption detection;
event emission; receipt rows.
Verify: after migration, 7-day spend on the four CanLaw lanes vs baseline
(target ≤ 40% of $1,305 at equal activity) and no-op share (target ≤ 25%);
job events observed for one real training round on cyan. Exit: those two
numbers plus a stall detected within one poll interval in a staged test.

### Phase 8 — Ops hygiene (B9, B10, B12, L9, L10, L12, L13, L14, probe hygiene)
- `session-history-sync`: throw on auth failure, one ticket per failing
  remote, back off to hourly after three failures (B10); fix or remove the
  `example-org/canlaw.git` credential.
- Briefing lock: release on empty result; add a third utility fallback (B9).
- Env sidecar: distinguish "key revoked" from "worktree gone" (B12); persist
  lane `/tmp` secrets in the sidecar; drain long machine runs before worker
  replacement or make `/tmp` survive deploys (L12).
- Secret scrubber on every tool output before it enters a transcript or a
  hook payload (gitleaks-class regexes; also the `[REDACTED]` patterns used
  by the ec2-ops probes) (L9).
- Teardown checklist as a platform-provided skill for serving lanes: remove
  cron/watchdogs, kill, verify dead ×3, default-deny ingress, key rotation
  step (L10).
- Derailment breaker: confirm 2ecde991 is deployed; add a per-run breaker on
  repeated identical tool calls and on `update_feedback` with non-existent
  ids; add a max-transcript-size guard that compacts before the provider
  rejects (L14).
- Candidate bugs: hooks debounce gate release; daily-cap EXPIRE; auto-mode
  child grant scope; shared-container `/tmp` wipe; egress allowlist by IP and
  MagicDNS.
Verify: app_error_logs classes over 24 h (sync warnings → 0 or one ticket;
`update_feedback` placeholder errors → 0); a staged key string in a tool
output is scrubbed; a deploy during a long run does not lose it. Exit: those
counts.

### Phase 9 — Spend governance
- `spend_events` table; ingest Brev weekly summaries, Nebius invoices and
  Fireworks events from the owner mailbox (parsers + a manual import path);
  attribute environments to goals via tags; budget envelope per goal in the
  goal record; alerts at 50/80/100%; idle-resource detection (a job watch
  with cost/h and no progress for N hours files a ticket).
- Digest and owner briefing carry: spend to date per goal, no-op share per
  lane this week, idle resources.
Verify: the CanLaw goal shows a dollar figure that matches the mailbox to
within 5% for the trailing week. Exit: that match.

### Phase 10 — CanLaw program items (coordinate with the owner; run in parallel with Phases 2–9 where independent)
Owner decisions to obtain first (ask once each, with a default and a
deadline): (1) run the full v0.8.1 eval on a RED checkpoint (default: yes,
once, ~$44); (2) bench gold as SFT dev set: accept and disclose, or carve a
disjoint dev set (default: carve, from `sft_pg_v4_patched`); (3) strict vs
lenient scoring as the board of record after the 09-08 bench audit;
(4) S3 retention: prune ≈11 TB of deltas and legacy copies (default: prune
deltas older than the newest closed round, keep legacy until a restore drill
passes); (5) the 09-18 date: keep as "first SFT score on v0.8.1" or drop.
Then:
- Run the full eval on the best available SFT checkpoint; publish the number
  with serving config beside it.
- Replace the 24-prompt closure probe with ≥200 prompts, FR/EN balanced,
  binomial CI printed beside the percentage; the bar is evaluated on the CI
  lower bound.
- SFT-1 post-mortem: smoke rounds 1, 4, 7, 8 on the dev split under one chat
  template; write the finding into the repo before the next SFT budget is
  set.
- Write `docs/path-c-sft2-rl-design.md` in `example-org/canlaw`: recipe
  (masking, LR, epochs, budget), probe and gate definitions, dense-model
  GSPO/GRPO rationale, pre-RL hybrid-arch checklist, dollars per stage.
  Commit the SFT masking code, the Fix-C patch, the closure probe, and
  `.digby/notes/path-c-ops.md`.
- Docs-keeper writes a structured `STATUS.md` (stage, run id, checkpoint,
  tokens, dev-gate result, bench score + version, open decision, spend to
  date), appended per event. Add a Models-tab entry for CanLaw-1F; retire or
  mark paused the Command A+ "next model" items.
- One monitor per lane (or job watches, Phase 7); standing power state
  machine in Path C's prompt; remove any remaining "never self-power" text.
- S3: lifecycle rules per decision (4); CloudTrail data-event trail on the
  bucket; one restore drill of a checkpoint round.
- Bench: re-score the 21 in-house rows on v0.8.1 or label them v0.8.0 on
  every surface; merge PRs #86, #88, #89 (or close with reasons); regenerate
  `bench-ui/meta.json test_count` inside CI or drop the pin; branch
  protection: block merge on pending checks; finish WS-B/C/D of the 09-08
  audit before any CanLaw claim; decide git-lfs; remove committed build
  output and scratch files.
- Rotate the three leaked keys if not already; apply the teardown checklist
  to every serving host.
Verify: each item has a concrete artifact (a score with config, a probe
report with CI, a committed doc, a lifecycle rule, a merged PR). Exit: the
CanLaw goal record names base model, bench version, bar, gate definitions,
and spend to date, and one SFT checkpoint has a v0.8.1 number.

---

## 5. Order and parallelism

Serial: 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9. Phase 10 runs alongside from
Phase 2 onward, gated on the five owner decisions. If a phase's post-deploy
check fails and cannot be fixed forward within the same day, roll back that
deploy and record it; do not stack a second phase on a broken one.

Report to the owner after each phase in plain English: what changed, the
before/after number, what is next. Keep the log current. When all phases are
verified, write a closing section in the log comparing every baseline number
from Phase 0 to its final value.
