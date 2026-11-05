# Cluster 8 · SAA-1 combined evidence matrix

**Audit window:** 2026-11-05T05:19Z–05:27Z (09:19–09:27 PM PST, 2026-11-04)
**Serving build at audit time:** `e05efd35` (box-c/worker, `servingBuild.upMin` 15→23)
**main head at audit time:** `4bf7d841` (`2026-11-05T05:15:11Z`)
**Route:** independent **read-only** evidence audit first, per the Fleet directive — no
implementation was written for any capability that did not already have one.

> **The four states are deliberately separate.** *Implemented* = the code exists.
> *Merged* = it is an ancestor of main. *Deployed* = it is an ancestor of the SHA a box
> is actually serving. *Behavior-verified* = production telemetry shows it doing the
> thing. Collapsing these is how "the code is there" gets mistaken for "it works" — the
> exact error this matrix exists to prevent. **A passing test suite is not a
> behavior-verified stamp**: it is the pre-condition for asking for one.

---

## 1. The matrix

| Capability | Implemented | Merged | Deployed | Behavior-verified | Residual gap |
|---|---|---|---|---|---|
| **SAA-1.1** trigger admission | ✅ `hook-source-policy.ts` (443 L) | ✅ `944315ad6` (`#2402`) | ✅ ancestor of `e05efd35` | ⚠ **observe only, now MEASURED** — precision **0.5 (a FLOOR)** over a **55.73 h** LATER-labelled window that **clears** the 48 h bar; `wouldHold 13 / wouldLose 13 / unresolved 13`, coverage `0.667`, 2,808 rows → 708 batches. Probe: `scripts/framework-audit/probe-saa1-suppression-precision.js` (read 2026-11-05T06:00Z, box A) | The `ignore` class has still **never been acted on** (`applied` is the literal `false` by type). Precision **0.5 means 13 of 26 resolved suppressions would have silenced a wake that ACTED** — the flip is **NOT recommended** on this reading. Window keeps accumulating under cadence `ff1c8d2c` (12 h × 6). |
| **SAA-1.2** owning-lane routing | ✅ `hook-thread-passthrough.ts` (207 L) | ✅ `cb9f6dd7d` (`#2447`) | ✅ ancestor of `e05efd35` | ✅ **ACTIVE** — 170 `hook_thread_passthrough_observe` rows; live re-targets (`applied:true`) observed this window including this lane | Thread-key continuity residual (cross-restart lineage) — tracked separately, not claimed here |
| **SAA-1.3** inline & spill | ✅ `inline-spill.ts` — **Phase 1**, three-state switch (`observe`/`apply`/`off`) | ✅ (registry row `INLINE_SPILL_INJECTION_DISABLED`, added 2026-11-02) | ✅ ancestor of `e05efd35` | ⚠ **observe only** — 526 `inline_spill_observe` rows, `applied:false`. `apply` has **never** been exercised in production | Switch must stay at the observe floor until Cluster 7's box-A canary passes. Flipping to `apply` is the Cluster 7 deliverable, not this audit's |
| **SAA-1.4** chain of recall | ✅ `chain-of-recall.ts` — **Phase 1**, three-state switch | ✅ (registry row `CHAIN_OF_RECALL_DISABLED`) | ✅ ancestor of `e05efd35` | ⚠ **observe only** — 1,122 `chain_of_recall_observe` rows, `applied:false`; a live row on chat `5c3f302e` confirms the surface is wired and computing hops | Same as SAA-1.3 — the `next:` append has never rendered in production |
| **SAA-1.6** async tools | ✅ `async-tool-calls.ts` + `async-tool-registry.ts` — **Phase 3b, the armed path** | ✅ `45c4deac7` (`#2462`) | ✅ ancestor of `e05efd35` | ✅ **ARMED IN PRODUCTION** — 424 `async_tool_calls_deliver` rows, `mode:"apply"`, **`ok:191 / fail:0` (rate 1.0)**, `p50 60,001 ms`, `p95 240,798 ms` | None outstanding for the 60 s path. Sub-60 s invariance pinned by drill, not by production (no sub-60 s row is emitted by design) |
| **MERGE-1** plain↔coding↔plain | ✅ `send-profile.ts` resolver + lazy-attach gate | ✅ | ✅ | ⚠ **NOT behavior-verified** — guard-order proven reachable **without a DB**; delivered-transcript duplication **8 real duplicate pairs / 30 d** (vs 56 content-identical *repetitions* that are legitimate) via `probe-merge1-dupclassify.js`; **no-loss leg VACUOUS in production** (`pending_chat_messages` = **0 rows in 30 d** — the queue never engaged); **plain→coding→plain continuity now pinned by test** (`send-profile.merge1-transcript-continuity.test.ts` 4/4 — one chat, 6 ordered messages, one id, reversible); **blue-green leg REPLAYED synthetically**: `message-queue.merge1-bluegreen.test.ts` 6/6 PASS (JEST_RC=0) proves normal handover is no-loss + no-duplication against the REAL `claimChatLiveRun` SET-NX gate. **Per this matrix's own legend these are pre-conditions, not a behavior-verified stamp** — production telemetry has not shown it | **Blue-green is proven for the NORMAL handover BY REPLAY ONLY, and a REACHABLE gap is pinned for the CUTOVER kill window.** `drainChatQueue` starts the run (`chat-agent.service.ts:1541`) and deletes the row AFTER (`:1607`), logging *"message may re-run"* — a colour killed in between leaves the row, and once `LIVE_RUN_TTL_SEC` (60 s) expires the surviving colour starts a SECOND run for the same content. The KILL WINDOW test reproduces exactly that (content begun twice), and a plain chat creates **no `agent_runs` row**, so busy-layer 3 cannot hold the survivor off. Mutation proof: delete-before-start turns it into LOSS. `coding_messages` DROP remains **unauthorised** |

### Legend
✅ verified by a receipt cited below · ⚠ proven only to the observe/partial floor ·
⛔ not met

---

## 2. Deploy-leg ancestry (this run, from the worktree)

`git merge-base --is-ancestor <commit> e05efd35` — the SHA box-c/worker was serving:

```
45c4deac7 -> e05efd35 CONTAINS (RC=0)   # SAA-1.6 Phase 3b (#2462)
80842d092 -> e05efd35 CONTAINS (RC=0)   # SAA-1.6 supporting
944315ad6 -> e05efd35 CONTAINS (RC=0)   # SAA-1.1 (#2402)
cb9f6dd7d -> e05efd35 CONTAINS (RC=0)   # SAA-1.2 (#2447)
```

All four likewise `CONTAINS (RC=0)` on `origin/main` = `4bf7d841`. So the **Deployed**
column rests on ancestry, not on a deploy log's success line.

---

## 3. Executable artifact

`backend/scripts/cluster8-evidence-drills.ts` — drives the **shipped modules** (no copies,
no re-implementations) over deterministic fixtures: fixed clock, fixed ids, seeded PRNG
(`mulberry32`), no DB, no network.

```
cd backend
# ⚠ The drill is NOT runnable bare. Its MERGE-1 leg imports the app config, whose
# Zod schema calls process.exit(1) when DATABASE_URL / JWT_SECRET are absent —
# verified 2026-11-05: bare `npx tsx scripts/cluster8-evidence-drills.ts` exits 1.
# Pass syntactically valid placeholders (it never connects):
DATABASE_URL='postgresql://u:p@127.0.0.1:5432/db' \
REDIS_URL='redis://127.0.0.1:6379' \
JWT_SECRET='drill-only-not-a-secret-000000000000' \
JWT_REFRESH_SECRET='drill-only-not-a-secret-111111111111' \
  npx tsx scripts/cluster8-evidence-drills.ts
=> VERDICT: ALL CHECKS PASS (52/52)   (exit 0)
```

It covers the six things the per-module suites structurally cannot, because those suites
are shaped per module:

### (a) SAA-1.1 — 240 events / 28 batches / 4 projects
- **ZERO false-suppressions** on the 20 must-run batches; **8/8** routine batches still
  reach `ignore` (the policy is not inert — a guard that never fires is not a guard).
- The must-run label is computed **independently** of the policy. Had it imported
  `POLICY_COVERED_EVENT_TYPES`, it would agree with the policy by construction and prove
  nothing.
- Fail-safes pinned: uncovered event type → `candidate`; stale batch → `candidate`
  (`stale_batch`), never `ignore`; `run_completed` with `sourceRunMutated:true` **or**
  `null` → `candidate`. Only an explicit `false` may permit `ignore`.
- Rollback drill: `HOOK_SOURCE_POLICY_DISABLED=1` → `mode:'off'`, suppresses nothing.
- **Flip criteria, reported separately from code presence** (the gate demands this):
  `suppressionPrecision([unresolved]) === null` — the function refuses to report a rate
  on an all-unresolved window. **MEASURED 2026-11-05T06:00Z (post-audit):** the window
  now resolves — a 55.73 h span clears the 48 h bar and yields **precision 0.5** (a
  floor), so precision is no longer INCONCLUSIVE. What remains separate from that code
  presence is unchanged: **no numeric flip threshold exists anywhere in shipped code**,
  the flip is a judgement on the measured number, and nothing has been flipped.

### (b) SAA-1.2 — 4-turn owner thread + 2 duplicate emissions
- **Synthetic drill:** all 4 turns reach the **owning lane**; **0 duplicate supervisor
  wakes**; duplicate hook emissions absorbed (4 deliveries for 4 events + 2 duplicates);
  exactly-once per event group; all turns land in **one** chat, so prior context is
  accumulated rather than re-sent piecemeal.
- **REAL RECORDED THREADS — `probe-saa12-real-thread.js`, box A, 2026-11-05T14:58Z
  (read-only, SELECT-only). VERDICT: PASS.**
  - 857 lineage-carrying chats scanned, **468 multi-turn** (>=2 user turns), **400 replayed**.
  - **5 real threads** carried a Phase-2 re-target row: `2edca824` (10 turns),
    `d58ffd04` (19), `c059d314` (2), `2c354da1` (3), `70d96298` (24).
  - **Owning lane == lineage parent: 5/5.** The lane routing names is the one the thread
    actually belongs to — the defect #2526 fixed does not reproduce.
  - **Duplicate wakes: 0.** Emission groups (keyed `hookId|source|eventType|runId`):
    **2431**, of which **1515 delivered exactly once**, **916** skipped-by-disabled-hook,
    **0** duplicate, **0** failed/lost. 1372 rows carry no `runId` and are reported
    UNGROUPABLE rather than counted as duplicates.
  - Phase-2 boundary **observed at 2026-11-04T03:33:05.394Z** (first `applied:true` row);
    **0** anomalies at/after the flip.
- **⚠ THIS PROBE'S FIRST VERSION CRIED WOLF — both alarms were PROBE defects, and the
  corrections are recorded in the file so the wrong read is not quoted later:**
  1. It called `applied:true` a *violation* on the strength of the `loop-metric-kinds.ts`
     doc comment describing SAA-1.2 as observe-only. **That comment is STALE** —
     `cb9f6dd7d` (#2447) shipped Phase 2, the flip; the fire site
     (`hooks.service.ts:3224`) does `if (threadDecision.applied) deliveryChatId =
     threadDecision.targetChatId`, and `threadPassthroughMetricMeta` returns `null`
     unless `applied` is truthy. A stored row can ONLY exist with `applied:true`.
     The first probe reported 190 "violations" that were Phase 2 working as designed.
  2. It grouped emissions on `hookId|source|eventType`, collapsing 38 separate
     `todo_done` events over 30 days into one pseudo-group and reporting 21 phantom
     "duplicate wakes". A real duplicate needs the **emission** identity (`payload.runId`).
  3. Six `applied:false` rows are a **pre-flip Phase-1 cohort** (last one
     2026-11-04T02:45:40Z, before the 03:33:05Z flip), not live anomalies —
     confirmed 0 false / 140 true in the trailing 24 h.
- Deliverability guards: archived parent / different-account parent / dead lineage edge
  each **keep** the wake on the subscribed target (`applied:false`) — the re-target
  cannot strand a wake.
- Rollback: kill switch routes every turn back to the subscribed target.
- **Partial-deploy drill:** the shipped metric helper returns `null` for
  `applied:false` + `owner_is_other_lane`, so pre-flip code **cannot** emit that row.
  Seeing such a row proves a **stale box**, never a flip failure.

### (c) SAA-1.6 — both sides of the 60 s boundary
- **59,999 ms → immediate**; **60,001 ms → handed off** with `att_<hex>` correlation id.
- **Sub-60 s is byte-identical**, leaves **no timer** and **no metric row**.
- **Mid-call steering:** the caller regains control while the tool still runs
  (`pendingCount() === 1`) — the whole point of the feature.
- **Delayed result exactly-once:** `drain1=1 / drain2=0`; the Started text forbids a
  re-call so a duplicate side effect cannot happen.
- **Failure path:** a rejected handed-off call still delivers exactly once, `ok:false`,
  and says "Do not retry".
- **Crash / throw:** `closeRun()` reports the still-running call as owed, and a result
  settling after close is **DELIVERED** through the `onLateResult` sink (ticket 9ecabc73);
  a result already in hand at run end is POSTED to the chat with its real text. Neither
  window is silent. The close is reachable from `runCodingAgent`'s `finally`, so a thrown
  run reports too.
- **Loss window 2:** settled-but-undrained before run end is reported owed, not dropped.
- **Observe mode:** crossing recorded, caller **not** released, eventual result still
  inline.

### (d) MERGE-1
- Four guard-order invariants exercised on the **real resolver** without a DB
  (escalation never converts; supervisor lane stays chat; non-owner never attaches;
  `probe:false` honoured); every reachable path declines to the `chat` profile and none
  attached a workspace.
- The satellite-true legs live in `send-profile.merge1.test.ts` +
  `coding-data.lazy-attach.merge1.test.ts` (green in this run's 124-test baseline).
- **Blue-green message integrity — REPLAYED (2026-11-05T14:44Z).** Production has no
  per-colour message ledger to diff, so the leg is replayed synthetically in
  `backend/src/modules/crossmodel/chat-agent/message-queue.merge1-bluegreen.test.ts`
  against the REAL `claimChatLiveRun` SET-NX gate over ONE shared Redis + ONE shared
  Postgres, with the process-local run registry modelled per colour (which is what
  actually differs per colour):
  - **NO-LOSS on a normal cutover** — a message queued while blue owns the chat is
    delivered after green takes over; the row is consumed exactly once.
  - **NO-DUPLICATION on a normal handover** — both colours drain concurrently (the ALB
    has no stickiness), exactly one starts the run.
  - **NO-DUPLICATION across a sequence of handovers**, FIFO preserved.
  - **KILL WINDOW — a REACHABLE gap, pinned not hidden.** `drainChatQueue` starts the
    run (`chat-agent.service.ts:1541`) and deletes the queued row **after**
    (`:1607`), logging *"message may re-run"* if that delete fails. A colour killed in
    between leaves the row alive; once `LIVE_RUN_TTL_SEC` (60 s) expires the surviving
    colour starts a SECOND run for the same content. The test reproduces the duplicate.
  - **MUTATION PROOF** — the same scenario under a delete-before-start ordering turns
    duplication into LOSS, so the kill-window assertion discriminates rather than
    passing vacuously.
  - Result: `6 passed, 6 total`, `JEST_RC=0`.
- **Not claimed:** a live deploy-boundary observation. The replay proves the shipped
  ordering; the kill window it exposes is an OPEN defect, not a tolerance.

### (e) Combined failure drills
- **Duplicate hook + late result in one scenario:** one route, one delivery.
- **Partial rollback:** killing SAA-1.2 leaves SAA-1.1 and SAA-1.6 at their prior
  behaviour — the features are independently switchable.
- **Full rollback:** all three kill switches restore pre-feature behaviour together.

---

## 4. Production telemetry receipts (behavior-verified leg)

Read this run via `get_fleet_telemetry view:'metrics'`, window 168 h, serving `e05efd35`:

| kind | rows | reading |
|---|---|---|
| `async_tool_calls_deliver` | **424** | `ok:191 / fail:0` → **rate 1.0**; `p50 60,001 ms`, `p95 240,798 ms`; rows carry `"apply":true` and real `att_…` ids (`browser_task`, `run_command`) |
| `async_tool_calls_observe` | 11,638 | threshold crossings recorded |
| `hook_source_policy_observe` | 2,781 | decisions recorded; `applied:false` throughout |
| `hook_thread_passthrough_observe` | 170 | live re-targets |
| `chain_of_recall_observe` | 1,122 | hops computed; latest row chat `5c3f302e`, `applied:false` |
| `inline_spill_observe` | 526 | plans computed; latest rows `applied:false`, `wouldInject`>0 |

**The single strongest behavioural result in this audit:** SAA-1.6 is genuinely armed in
production and has delivered **191 successful async deliveries with zero failures** at a
60 s p50. That is behavior-verified in the strict sense — not inferred from a switch's
presence.

---

## 5. What this audit did NOT establish (honest limits)

1. **SAA-1.1, SAA-1.3, SAA-1.4 have never *acted* in production.** They observe. Their
   `apply` paths are implemented, merged and deployed but unexercised. Flipping any of
   them needs the Cluster 7 box-A canary/wake probes first — and those are blocked on
   `shaEvidence.settled:true`, which read `false` at 05:19:37.912Z (`wave_in_flight`,
   runs `41971096152` `04e1917f` in_progress and `41972836305` `4bf7d841` pending).
2. **MERGE-1 blue-green integrity is proven BY SYNTHETIC REPLAY ONLY — it is NOT
   behavior-verified in this matrix's sense** (production telemetry has not shown it
   doing the thing). The replay
   (`message-queue.merge1-bluegreen.test.ts`, 6/6) drives the shipped drain ordering
   against the real SET-NX gate; it does not observe a production cutover. It also
   **exposed a reachable defect**: the row is deleted AFTER the run starts
   (`chat-agent.service.ts:1607`), so a colour killed mid-drain leaves the row and the
   surviving colour re-delivers it once the 60 s liveness key expires. That gap is
   pinned as a failing-behaviour test, not claimed closed.
3. **The drill runs against source, not the deployed dist.** It proves the shipped logic;
   the dist-level proof is the Cluster 7 probes' job. These are complementary, not
   interchangeable.
4. **Fixtures are synthetic.** Production diversity for several of these paths is thin;
   per the standing completion doctrine, deterministic fixtures stand in — they never
   justify *fabricated precision*. **UPDATE 2026-11-05T06:00Z:** the SAA-1.1 precision is
   no longer fixture-only — it is a MEASURED production number (**0.5, a floor**) over a
   55.73 h LATER-labelled window. MERGE-1's duplication leg is likewise measured in
   production (8 real pairs / 30 d); its no-loss leg is **vacuous** (0 queue rows), which
   is a fact about production volume, not a fixture substituting for one.

---

## 6. Residual gaps and their owners

| Gap | Owner / disposition |
|---|---|
| Cluster 7 box-A canary + wake probes (unblocks SAA-1.3/1.4 apply verification) | todo `2ef2b254`, this lane, **blocked** on `shaEvidence.settled:true`; condition wake armed on deploy `04e1917f`, horizon `2026-11-05T08:14:54Z` |
| SAA-1.1 flip to `ignore` | needs a 48 h LATER-labelled precision window; no owner assigned — **not** something a test can manufacture |
| SAA-1.2 thread-key continuity | tracked separately in the backlog; not claimed closed here |
| MERGE-1 blue-green no-loss/no-duplicate (NORMAL handover) | **REPLAYED 2026-11-05T14:44Z** — `message-queue.merge1-bluegreen.test.ts` 6/6 (JEST_RC=0). Still owed: a live deploy-boundary observation |
| MERGE-1 **cutover kill-window duplication** (NEW, found by the replay) | Row deleted AFTER the run starts (`chat-agent.service.ts:1607`) -> a colour killed mid-drain leaves it queued; after `LIVE_RUN_TTL_SEC` (60 s) the surviving colour re-delivers the same content. **Not fixed here** (an ordering change to the drain is a production behaviour change needing its own focused fix + CI + deploy verification). Recommended fix: claim-then-delete atomically before starting the run, or stamp the row with a claim token and make the re-drain a no-op for a delivered row |
| `coding_messages` DROP | **owner-gated, NOT authorised** — untouched by this audit |

**Deploy convergence (observed, not this lane's to fix):** box-a moved **backward**
`e05efd35 → 32c1b04f` (git: `merge-base --is-ancestor e05efd35 32c1b04f` → RC=1) while
`deployWave.inFlight` was true, and the previous firing saw `32c1b04f → 4c11e4b5` with run
`41961527928` concluding **cancelled**. Reported for the Framework Operator lane; this
lane does not escalate it.

---

## 7. Reproduce

```bash
cd backend
# The MERGE-1 resolver leg imports the app config, whose Zod schema exits the
# process when these are absent — so the drill needs placeholders to reach
# end (any syntactically valid values; it never connects):
DATABASE_URL='postgresql://u:p@127.0.0.1:5432/db' \
REDIS_URL='redis://127.0.0.1:6379' \
JWT_SECRET='drill-only-not-a-secret-000000000000' \
JWT_REFRESH_SECRET='drill-only-not-a-secret-111111111111' \
  npx tsx scripts/cluster8-evidence-drills.ts          # 52/52, exit 0

npx jest src/modules/crossmodel/chat-agent/message-queue.merge1-bluegreen.test.ts   # 6/6, blue-green replay
npx jest src/modules/crossmodel/platform/saa1-phase1.replay-fixtures.test.ts \
         src/modules/crossmodel/platform/saa1-phase1.policy.test.ts \
         src/modules/crossmodel/platform/hook-thread-passthrough.apply.test.ts \
         src/modules/crossmodel/platform/async-tool-calls.test.ts \
         src/modules/crossmodel/platform/send-profile.merge1.test.ts \
         src/modules/crossmodel/coding/coding-data.lazy-attach.merge1.test.ts
```

The blue-green replay needs no environment at all — it mocks Redis, Prisma and the
error handler, and drives the real `claimChatLiveRun` gate over a single shared keyspace.
The drill's MERGE-1 leg is the only part needing the placeholders above.

The drill needs no environment for SAA-1.1/1.2/1.6 or the combined drills; the MERGE-1
resolver leg imports the app config and therefore needs placeholder `DATABASE_URL` /
`REDIS_URL` / `JWT_SECRET` / `JWT_REFRESH_SECRET` (any syntactically valid values — it
never connects; it only proves which guards are reachable without a satellite row).

Leg (b) against REAL recorded threads runs on a production box, read-only, through the
SSM path (no SSH key; see the learnings entry on probe invocation — the HOST has no node
and no `/app/dist`, so it must go through `docker exec` into the app container):

```bash
# from the repo root, AWS creds exported as AWS_ACCESS_KEY_ID/SECRET (the injected
# *_DIGBYOPERATOR names must be MAPPED first — run-on-box.sh reads the bare names):
scripts/framework-audit/run-on-box.sh A \
  "bash /opt/crossmodel/scripts/framework-audit/prodq.sh /opt/crossmodel/scripts/framework-audit/probe-saa12-real-thread.js"
```

`PROBE_WINDOW_DAYS` (default 30) bounds the window. It is SELECT-only and flips nothing.
