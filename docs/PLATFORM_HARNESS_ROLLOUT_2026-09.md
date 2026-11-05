# Platform Harness Upgrade — Rollout Plan (2026-09)

> **STATUS (2026-09-09): superseded-in-part by the AUTONOMY REMEDIATION PROGRAM**
> — the phased close-out of three independently-audited review briefs, tracked in
> [`docs/reviews/2026-09-09-autonomy-remediation-record.md`](reviews/2026-09-09-autonomy-remediation-record.md)
> (program header + phase table 0–9 + already-fixed resolution analysis).
> Phase 0 (instrumentation + safety net: metric stamps N6, `agent_runs.startedAt`
> L13, price-table reconcile v1#17, new loop_metrics kinds, fleet-status SQL
> probe, docs-drift fixes incl. B29) **landed with that record**. Later phases
> land against the record's table — check it before extending THIS plan.

> Written 2026-09-02 in response to the **Digby Deep Audit** (2026-08-31, 14 agents, repo
> snapshot `19a6dfb6`). Every load-bearing audit claim was re-verified against current HEAD
> (`1a9cce94`, ~181 commits past the audit snapshot) before planning. Section 1 is the
> fact-check, §2 the agree/disagree positions, §3–6 the rollout.

---

## 1 · Fact-check of the audit (fresh evidence, this session)

### 1.1 The critical finding — CONFIRMED

| Sub-claim | Verdict | Fresh evidence |
|---|---|---|
| No CI test gate in any workflow | **CONFIRMED** | Only 4 workflows exist (`deploy.yml`, `deploy-healthcheck.yml`, `ec2-ops.yml`, `infrastructure.yml`); repo-wide grep for `jest\|vitest\|tsc\|npm test\|lint` across `.github/workflows/` returns zero hits. |
| `main` is unprotected | **CONFIRMED** | GitHub API `GET /repos/example-org/crossmodel/branches/main` → `"protected": false` (verified 2026-09-02). |
| Untrusted ticket text reaches auto-mode sessions with push access | **CONFIRMED** | `ticket-dispatch.service.ts:270-282` embeds ticket title/description verbatim into the run's firing message; the code's own comment concedes *"this brief lands in an auto-mode session with push access"* (`:216-222`). Sessions are instructed to *"MERGE the PR to main yourself"* (`:208`); merges happen via `run_command` + GitHub REST — outside every tool gate. Webhook text lands the same way (`webhook.service.ts:56-89`). |
| Nobody reviews diff content | **CONFIRMED** | The evidence guards verify *claims about* actions (`run-evidence-guard.ts`), never the content of diffs. Existing breaks in the chain are config gates (`TICKET_DISPATCH_ENABLED`, daily cap 40, user-source-only dispatch, secret-scan at commit) and prompt-level framing — nothing code-enforced gates the merge. |

**The composed attack path (injected ticket → autonomous merge → prod deploy) stands.**

### 1.2 The "genuinely strong" section — CONFIRMED (and it got stronger)

| Claim | Verdict | Fresh evidence |
|---|---|---|
| Attempt accounting (bounces neutral, contention refunds, crash loops exhaust cap, named cause chains) | **CONFIRMED** | `run-state.ts:158-179` (atomic interrupt + decrement), `run-claim.ts:183-207` (worker-generation compensation), `:225-240` (requeue refund), `ATTEMPTS_CAP=3` `run-state.ts:295`, cause chains at `run-executor.ts:274,1075`. |
| Resume-after-deploy (cooperative SIGTERM, write-ahead checkpoints + git snapshots, cold-retry, stale-clock regen) | **CONFIRMED** | `worker.ts:220-250` cooperative stop; `run-executor.ts:721-739` checkpoint hook; `workspace.service.ts:485-533` snapshot incl. untracked; cold-retry `run-executor.ts:1060-1082`; stale-clock regen `agent.ts:623-644`. |
| Anti-confabulation stack (harness receipts, fail-closed guards, LLM-free journal verdict lane) | **CONFIRMED, extended** | `run-receipts.ts:7-18`; `run-evidence-guard.ts:44-48` (no LLM, never throws — note infra errors fail *open* by design); verdict lane `run-journal.service.ts:141-200` now covers guards 1–6. **Since the audit:** `33ad37c6` (#580) added evidence-guard **reject-back-to-model** for convicted machine-run finals (+220 test lines) and `609c7fb7` (#592) extended it to machine wakes — the stack evolved from suppress/redact to reject-back. |
| Incident-pinned tests: 170 suites / ~4,112 tests | **CONFIRMED** | Measured now: **171 suites, ~4,123 tests** in `backend/src`. |
| Delegated workers inside the evidence chain; writers never parallel | **CONFIRMED** | Receipts/spend spread `agent.ts:272-285,850`; role policy enforced at execution `agent.ts:491-502,777-784`; writer-parallel rejected `agent.ts:518` + `roles.ts:131`. |
| 241 commits in 48h | **PARTLY** | Not reproduced on first-parent main: 67 commits 08-29→08-31, 181 commits 08-30→09-02. Directionally right (extreme velocity), exact figure unverified. |

### 1.3 Top issues — verdicts

| # | Audit claim | Verdict | Fresh evidence |
|---|---|---|---|
| 1 | No prompt caching anywhere; ~800K-char transcripts reshipped | **CONFIRMED** | `coding-model.ts:362-373` payload has no cache fields; grep for `cache_control\|prompt.?cach\|context.?cach` across `backend/src` = zero hits. 800K = kimi-k3 `contextChars` ceiling (`coding-model.ts:101`). **Nuance:** the code *fallback* is `glm-5.2` (`coding-model.ts:30`) but the fleet effectively runs Moonshot (row 6) — Moonshot context-caching is the first-order lever; make the implementation provider-aware (GLM/DeepSeek remain user-selectable). |
| 2 | Continuations structurally 15 min late; consume daily cap; MAX_CONT_ROUNDS=3 | **CONFIRMED** | `run-executor.ts:985-989` creates `kind:'once'` at `MIN_INTERVAL_SEC=900` (`schedule.service.ts:28`); stale-wake comment `:990-999`; `MAX_CONT_ROUNDS=3` `:973`; cap consumption `schedule.service.ts:578-598,832-844`. |
| 3 | Checkpoint write amplification; no throttle/delta/**fence** | **CONFIRMED** | `checkpoint('preModel')` every step (`agent.ts:1055`), `checkpoint('dispatch')` before every tool call (`agent.ts:1447-1449`); full-transcript JSON per write (`agent.ts:985-992` → `run-state.ts:104-115`); **5** git subprocesses per snapshot (`workspace.service.ts:514-525`); `version:1` is a static tag, not monotonic; `lastCheckpointWrite` overwritten, never chained (`run-executor.ts:724`) → out-of-order writes can resurrect stale checkpoints and re-execute turns. |
| 4 | Learnings write-never-read: 183 entries, only first 4,000 chars injected | **CONFIRMED** (count now 187 / 93.5KB) | Sole read path `agent.ts:399-402` — `learnings.slice(0, 4000)`; only the ~10 **oldest** entries ever injected; no retrieval/ranking exists. Bonus findings: **exactly 7 verbatim duplicate pairs** (lines 34↔63 … 54↔69), near-dup clusters ("gh CLI" ×4), **conflicting entries** (migrate-diff flag 31 vs 160), and **mid-word splice corruption** at lines 126-127. `search_memory` is session-scope only (`coding-retrieval.service.ts:39`); learnings/journals/project notes are never embedded anywhere. |
| 5 | Zero spend/metrics accounting | **CONFIRMED** | No per-run/per-day $ metering, no events table, no alerting found in the coding plane. Daily wake cap exists (`schedule.service.ts:584`, cap 48 or `scheduleCap` ≤1440) but meters *count*, not *cost*. |
| 6 | Coding plane = Kimi K3/Moonshot SPOF, fail-fast not failover | **CONFIRMED — operational SPOF (owner-corrected 2026-09-02)** | An earlier draft of this table refuted the claim on the code *fallback* default (`glm-5.2`, `coding-model.ts:30`) — wrong axis. The run model is `session.model` (`run-executor.ts:691`), resolved at creation from the **owner's stored pref = kimi-k3** (`platform.service.ts:1445-1446`, `coding-data.service.ts:525-533`; the K2.6→K3 forward-mapping exists precisely to never strand that pref on the GLM fallback), and delegates inherit it (`agent.ts:847`, helperTier excepted). Owner confirms the coding plane runs K3 always (2026-09-02); corroborated by the owner's K3 1M-window question in coding sessions (memory-bank crossmodel-progress.md:255) and the provider-429 incident whose pinned fixture runs `kimi-k3` (`sched-provider-fail.test.ts:324`; fail-fast surfacing shipped as PR #374 — the audit's "fail-fast, not failover"). Chat plane is *hard-coded* K3 (`chat-agent.service.ts:60-64`). Provider resolved once per run (`coding-model.ts:163-186`), retries hit the same provider (`agent.ts:1232-1270`), zero cross-provider fallback. Moonshot is a fleet-wide SPOF in BOTH planes. Open decision: the glm-5.2 *fallback* default (4 call sites + DB column default) predates the K3 policy — flip it to kimi-k3 or keep multi-model deliberately. |
| 7 | One interactive worker slot at saturation | **STALE** | Box C is a dedicated coding box; `CODING_WORKER_CONCURRENCY` defaults to **12** in the compose template (`docker-compose.app.yml`) and runs at **32** on box C (owner-ordered, `/opt/crossmodel-local/env-overrides.env` via playbook one-shot CC0902; verified 2026-09-25), with a last-slot interactive reservation (`worker.ts:175-186`). |
| 8 | Wedged run renews its own lease (heartbeat = timer, not progress) | **CONFIRMED** | `heartbeatAgentRun` is a "liveness-only beat" piggybacking the lock-refresh interval (`run-state.ts:117-123`); no step/progress signal accompanies it. A run wedged mid-step with a live timer keeps its lease. |
| 9 | Session run-lock not fenced | **PARTLY** | Cross-instance Redis lock with holder-only refresh exists (`session-run-lock.ts:26-32`, blue-green safe), but no fencing token/monotonic epoch was observed — a stale holder that regains connectivity can act on an expired lock. |
| 10 | ec2-ops silently skips new one-shots (ticket 795cc5fb) | **CONSISTENT, not re-verified live** | `scripts/ec2-ops/playbook.sh` is marker-guarded one-shots echoing "already done" (lines 125,156,189,348…) — the skip-with-success pattern is real by design; whether *new* blocks currently skip needs prod access this session does not have. |
| 11 | Guard regex arms race (~27 guard commits/3 days) | **CONFIRMED (21 in 4 days)** | `git log 08-28→09-01` shows 21 guard/evidence commits, incl. run-evidence-guard hardening "round-2" through "round-8" on ticket f1afaa7b. |

### 1.4 Learning-loop detail claims — verdicts

> ⚠ STALE (2026-09-08): the `helperTier` row below and PHASE 1 items 1.4–1.5 predate the 2026-09-08 re-tier — the verifier now runs `helperTier: true` on the Helper seat (`qwen3.6-27b`), the editor was re-tiered onto the coding model (`roles.ts`, commit `6527f49b`), and the `MAX_DELEGATIONS` const was removed entirely (`CODING_PROFILE.maxDelegations` is the only delegation budget).

| Claim | Verdict | Fresh evidence |
|---|---|---|
| `helperTier` exists, nothing sets it | **CONFIRMED** | Defined `roles.ts:28`; consumed live at `agent.ts:847` (`ROLES[role].helperTier ? HELPER_MODEL : input.model`); `roles.test.ts:147` asserts **every** role's `helperTier` is undefined. Wiring works; zero roles opted in. |
| `MAX_DELEGATIONS` dead | **CONFIRMED** | Defined `agent.ts:57`, referenced only in a comment (`:1462`); no enforcement check exists. |
| tools.ts:1204 = learnings union-merge write path | **STALE** | That line is now `search_memory` dispatch; no merge tool exists — entries are hand-appended via `edit_file`. The write-never-read conclusion is unaffected. |
| Journals siloed per chat | **CONFIRMED** | `run-journal.service.ts` is explicitly a "durable, per-chat, APPEND-ONLY journal"; reads are per-`chatId`; workers inherit the parent's journal via session spread. No cross-chat/project failure bridge exists. |
| Four separate finalize utility-LLM calls | **CONFIRMED** | Journal distill (`run-journal.service.ts:71+`), session summary, project fold, user fold — separate calls at the finalize seam (`run-executor.ts:1119-1170`), wholesale-rewrite semantics. |

---

## 2 · Where I agree / disagree

### Agree — and the plan adopts these wholesale

1. **§1 is the top priority.** The CI-gate + branch-protection fix is correctly ranked #1 for both security and ordinary quality. No pushback.
2. **Continuation fast-lane (#2) and alarm-class wakes (#3).** The 15-min tax is verified in code and absurd on its face; failures must never be silenced by a budget counter.
3. **The counterargument on sub-sessions.** "Promote, don't build — but after delegation checkpointing + a typed worker result envelope" is the right sequencing, for the stated reason: every session-shaped worker so far has needed its own reaper rule, and the phantom-dispatch surface widens with every new dispatch path. Sub-sessions are Phase 4, not Phase 1.
4. **Claims-with-receipts (#6) as the structural exit from the guard arms race.** 21 guard commits in 4 days is a text-matching treadmill; typed claims verified against the receipt log retires it. The reject-back work (#580/#592) since the audit is complementary, not a substitute.
5. **Learnings retrieval (#11) is the highest-leverage self-enhancement item.** Verified: 187 lessons, ~10 visible, 7 verbatim dup pairs, splice corruption, conflicting guidance. The loop currently writes to a file nobody reads.

### Disagree / amend

1. **"Moonshot context-caching is the single largest lever" — confirmed first-order (owner-corrected 2026-09-02); amend the implementation to provider-aware.** An earlier draft deprioritized this on the glm-5.2 code *fallback* — wrong axis: the fleet's stored pref is kimi-k3, so Moonshot carries the operational load and context-caching there IS the largest single wall-clock + spend lever, as the audit said. What survives of the amendment: build it provider-aware (Moonshot context-cache API first; ZAI/DeepSeek equivalents and automatic prefix-caching where offered), since GLM/DeepSeek remain user-selectable. Telemetry (#12) stays the prerequisite for *proving* the win, not for starting it.
2. **Unified telemetry is ranked too low at #12.** Every other item in §4 is unverifiable without it — you cannot prove the caching win, the checkpoint-throttle win, or a 10× cost regression without per-run spend and an events stream. A *minimal* version (one events table + per-run token/cost metering) belongs in Phase 1; the full dashboards stay in Phase 3.
3. **The fragility section needs a 2026-09 refresh — but only the worker-slot claim is stale.** "Whole coding plane on Kimi K3" is NOT stale: owner-confirmed 2026-09-02 that the coding plane runs K3 always (stored pref → `session.model` → worker inheritance; see 1.3 row 6), and the chat plane is hard-coded K3 — Moonshot is a two-plane SPOF. "One interactive worker slot" IS stale (box C × 12 slots, `docker-compose.app.yml:283`). The *surviving* items — no cross-provider failover, timer-only heartbeat, unfenced run-lock — are real and are kept, re-scoped.
4. **`MAX_DELEGATIONS`: don't delete — enforce.** The audit lists "delete dead MAX_DELEGATIONS" as a cheap rider. It's a per-run cost guard that was never wired; at depth-1 with per-role `maxSteps` the damage is bounded, but an enforced cap is ~5 lines and turns a comment into a contract. Enforce, don't delete.
5. **Deploy-gate alternative considered and rejected:** gating *deploys* instead of merges (run tests in `deploy.yml`) would leave broken/injected code on `main` and only catch it at deploy time. Gate at the merge. Also rejected: diff-content LLM review as a *blocking* gate — useful as an advisory lane later, but a blocking LLM gate is itself prompt-injectable; the deterministic gate is CI + branch protection.

---

## 3 · Rollout plan

Phase gates: each phase ships behind the repo's normal flow (PR → green CI → merge → blue-green deploy). Effort: S < 1 day · M = 1–3 days · L > 3 days (single-session equivalent).

### PHASE 0 — Close the critical path (target: week 1)

| # | Item | Effort | Acceptance criteria | Dependencies / risks |
|---|---|---|---|---|
| 0.1 | **CI gate**: `.github/workflows/ci.yml` running `tsc --noEmit` + `npx jest` (+ frontend lint) on every PR and push to `main` | S | Workflow green on a test PR; a deliberately failing test blocks merge | None. Risk: suite runtime — shard jest if > ~10 min. |
| 0.2 | **Branch protection on `main`**: require PR + `ci` status check; no direct pushes; admin bypass for ops emergencies | S | API shows `protected: true`; direct push rejected; session merge flow (REST `PUT /pulls/:n/merge`) still works when checks green | 0.1. Risk: fleet sessions that push straight to `main` break — audit the push path first (`pushSessionBranch` pushes the *session branch*; merges already go through PRs per `ticket-dispatch.service.ts:208`, so exposure is low). Deploy workflow triggers on merge — unchanged. |
| 0.3 | **Continuation fast-lane**: unfinished-work backstop enqueues a direct requeue (DB not-before ~0) instead of a 900s `kind:'once'` schedule; continuations exempt from the daily fire cap; keep `MAX_CONT_ROUNDS=3` + stale-snapshot guard | S | A run ending with open plan steps resumes in < 60s; fire-cap counter untouched; `skipped:obsolete` path still handles stale wakes | `run-executor.ts:985-1016`, `schedule.service.ts:578-598`. Risk: hot-loop continuations — keep the round cap and a small backoff. |
| 0.4 | **Alarm-class wakes bypass caps**: `run_failed`/`attention_needed`/`goal_blocked` hook wakes never count against schedule caps and never expire | S/M | On a capped day, a forced failure still wakes the supervisor (test); normal wakes still capped | `hook` delivery path + `schedule.service.ts:832-844`. |

### PHASE 1 — Latency, cost, integrity quick wins (weeks 2–3)

| # | Item | Effort | Acceptance criteria | Dependencies / risks |
|---|---|---|---|---|
| 1.1 | **Minimal loop telemetry** *(promoted from audit #12)*: one `loop_events` table (strikes, wakes, fires, guard verdicts, deploys) + per-run token/cost metering written at finalize | M | Per-run $ visible on the run row; daily rollup queryable; one alert threshold (daily spend > N) wired to an owner notification | Prisma migration (hand-written per convention). Unblocks measurement for 1.2/1.3. |
| 1.2 | **Provider-aware prompt caching**: implement per-provider cache params, ordered by measured traffic share from 1.1; prefix stability is already verified | M | Cache-hit metrics (or provider cached-token counts) logged per run; wall-clock per turn measurably down on cached turns; zero payload regressions on providers without caching (feature-detect, don't blanket-send) | 1.1. Risk: provider API drift — isolate per-provider adapters in `coding-model.ts`. |
| 1.3 | **Checkpoint throttle + monotonic fence**: coalesce pre-dispatch checkpoints (latest-wins within a step); add a monotonic `checkpointSeq` written in the same UPDATE's WHERE clause so stale writes lose; chain `lastCheckpointWrite` | M | Forced out-of-order write in a test cannot resurrect an older checkpoint; checkpoint write volume per run measurably down | `run-state.ts:104-115`, `run-executor.ts:721-739`. Risk: resume semantics — keep `trimToPreModel` behavior, extend tests. |
| 1.4 | **Worker model tiering**: set `helperTier: true` on mechanical roles (scrape/fetch/verify-adjacent) | S | Delegations for those roles emit `model: HELPER_MODEL` (`agent.ts:847`); `roles.test.ts:147` updated; verifier/reviewer stay premium | Wiring already live. |
| 1.5 | **Enforce `MAX_DELEGATIONS`** as a hard cap in `delegate` | S | 21st delegation in a run is rejected with a clear message; test added | `agent.ts:57`. |
| 1.6 | **Idempotent push/PR on resume**: resumed runs detect an already-pushed sha / already-open PR instead of re-executing | S | Resume-after-crash test: no duplicate PR, no double-push | 1.3. |
| 1.7 | **Progress-signal heartbeat**: heartbeat carries `currentStep + lastToolAt`; reaper treats step-stale runs as wedged after threshold | M | A wedged-mid-step run loses its lease in test; healthy long tool calls (background processes) don't false-positive | `run-state.ts:117-123`, `run-reaper.ts`. |
| 1.8 | **Fence the session run-lock** with a monotonic epoch/token; holders validate before mutating | M | Stale-holder regression test passes | `session-run-lock.ts`. |
| 1.9 | Cheap riders batch: AGENTS.md box-C section + stale-banners on memory-bank; fix learnings.md splice corruption (lines 126-127) + drop the 7 verbatim dup pairs + reconcile the migrate-diff conflict (31 vs 160) | S | Docs committed; learnings.md deduped | None. |

### PHASE 2 — Structural integrity (weeks 3–6)

| # | Item | Effort | Acceptance criteria | Dependencies / risks |
|---|---|---|---|---|
| 2.1 | **Claims-with-receipts protocol**: typed `CLAIMS` block in the final answer; each claim references receipt ids; the guard verifies by receipt lookup, prose becomes advisory; reject-back (#580) consumes the typed verdict | L→M | Guard verdicts derive from receipts not regex for the typed claim classes; the f1afaa7b-style arms-race test files stop growing; migration path keeps prose-claim lanes for legacy runs | 0.1 (CI). Risk: model non-compliance — reject-back loop already exists to enforce format. |
| 2.2 | **Verified-close for tickets + mandatory incident-replay tests**: a mishap ticket cannot close without a replay regression test; closure requires cited evidence | M | Ticket close without linked test is rejected (tool-level); one historical mishap retrofitted as the pattern example | `update_feedback` handler (apply-or-reject convention per learnings). |
| 2.3 | **Learnings retrieval on pgvector**: ingest learnings into `digby_memory` at **project scope** (one row per lesson, code-index pattern); widen `search_memory` to session+project scopes; inject top 3–5 relevant lessons at run start; **re-query on tool failure**; nightly dedupe pass | M | A lesson from entry #150 is retrieved by a relevant query in a test session; injection replaces the 4,000-char prefix slice; duplicate rate stops growing | 1.9 (clean source data first). Risk: embedding cost — dedupe before ingest. |
| 2.4 | **Cross-provider failover for the coding plane**: per-run provider chain (primary → fallback), reusing the existing GLM/DeepSeek/Moonshot clients; 429/5xx after retry budget fails over instead of failing the run | M | Forced provider outage in test: run completes on fallback with an honest journal note; billing-outage ticket path retained for all-providers-down | `coding-model.ts:163-186`, `agent.ts:1232-1270`. |
| 2.5 | **Dispatch hygiene**: liveness reclaim for dead lane slots, capacity refunds on failed dispatch, class-keyed mishap dedup | S | Stuck-provisioning row reclaims in test (the 4-day lane-slot incident shape) | `ticket-dispatch.service.ts`. |

### PHASE 3 — The self-enhancing loop (weeks 5–8, overlaps Phase 2)

| # | Item | Effort | Acceptance criteria | Dependencies / risks |
|---|---|---|---|---|
| 3.1 | **Unified telemetry dashboards + owner report**: daily/weekly digest generated from `loop_events`, not from chat narratives | M | Owner report cites table rows; spend trend visible per day/model/role | 1.1. |
| 3.2 | **Dream-pass**: weekly job clusters recurring failure strings across all chats' journals → drafts learnings candidates (as tickets, not auto-commits) | M | A seeded recurring failure produces a candidate lesson; dedupe against existing learnings | 2.3. Risk: candidate quality — human/nightly-engineer review gate. |
| 3.3 | **Cross-chat failure visibility**: journal failure entries bridged into project-scope memory; sibling sessions retrieve "last run touching this file failed because X" | M | Cross-chat retrieval test passes | 2.3. |
| 3.4 | **One finalize call with delta semantics**: merge journal distill + session summary + project fold + user fold into a single utility-LLM call with explicit keep/add/drop semantics | M | Finalize utility calls per terminal run: 4 → 1; still-valid notes survive (regression test on fold output) | None. Risk: single-call quality — eval on historical folds. |
| 3.5 | **Agent-behavior evals**: replay harness over canonical transcripts; prompt changes must pass behavior suite (the jest-for-prompts) | L | Eval suite runs in CI on prompt-file diffs; one seeded behavior regression caught | 0.1, 2.1. |
| 3.6 | **Advisory diff-review lane** (non-blocking): LLM review of PR diffs from ticket-dispatched sessions, posted as PR comment; explicitly NOT a gate (a blocking LLM gate is itself injectable) | M | Review comments appear on dispatched PRs | 0.2. |

### PHASE 4 — Sub-session promotion (after 2.1 + prerequisites)

Prerequisites **first** (the audit's counterargument, adopted):
1. **Delegation checkpointing** — workers currently get `onCheckpoint: undefined` (`agent.ts:850`); a bounce re-runs a whole 80-step delegation. Give workers checkpoints inside the parent's run.
2. **Typed worker result envelope** — `{status, blockedReason, artifacts}` footer instead of the 200-char regex on prose.

Then the five composition pieces (~M total, no new machinery):
| Piece | Shape |
|---|---|
| Lineage | `parentChatId` column + sidebar grouping |
| Result return | auto-created `run_completed` → parent hook at spawn |
| Steering rights | implicit autonomy scope of parent over own children |
| Context inheritance | parent's recent journal entries injected into child's first prompt |
| Lifecycle | idle-child auto-archive + child spend attributed to parent budget (uses 1.1) — **day one, non-negotiable given the orphan-session history** |

---

## 4 · Explicitly deferred (audit's cut list, endorsed)

page.tsx split · GHCR image builds · Redis de-SPOF · per-project sub-supervisors — all real, all weaker strength-per-effort than everything above. Revisit after Phase 3. `ec2-ops` one-shot skip (ticket 795cc5fb) is an ops-channel fix tracked by its own ticket; it blocks live-DB verification, not this plan.

## 5 · Success metrics (checked at each phase gate)

- **Security**: `protected: true` on main; zero merges without green CI (API-verifiable).
- **Latency**: median autonomous-round gap 15 min → < 60 s; cached-turn wall-clock delta measurable from 1.1 data.
- **Cost**: per-run $ visible; helper-tier delegation share > 0%; finalize utility calls 4 → 1.
- **Integrity**: guard-commit cadence (21/4d) trending toward zero as 2.1 lands; checkpoint writes per run down; zero stale-checkpoint resurrections in tests.
- **Learning**: % of learnings retrievable via `search_memory` (target 100% vs ~5% today); duplicate-pair count 7 → 0 and staying there.

---

*Method note: fact-check performed 2026-09-02 by 4 parallel read-only explorer agents + direct git/API checks against HEAD `1a9cce94`; all citations verified in this session. Live production DB state was not consulted (no prod access from the session container); run-rate claims from the audit were treated as directional.*
