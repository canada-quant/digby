# Decision-gate rollout playbook — how the framework flips its own judgments to Jev

**Status (2026-09-27):** LIVE on merge. Owner ask (2026-09-27): "make sure the
framework for digby/crossmodel understands how to progressively flip over things
to jev properly once it is hardened and understands all the decision model roles
in the framework so it can take back over everything." Standing pre-authorisation:
2026-09-25 21:20Z (flip purposes to act one by one as each readiness bar holds)
and 2026-09-26 00:20Z ("why dont you just start flipping things and monitoring").

**Source of truth in code:** `backend/src/modules/crossmodel/platform/decision-gate-registry.ts`
(one row per purpose; `decision-gate-registry.test.ts` pins registry == runtime),
served as `GET /admin/model-roles/decision-registry`, shown in Account → Admin →
Endpoints → Model roles → Decision gate → "Decision roles registry + rollout
automaton", and read by every supervisor through `get_decision_gate_status`.
Every state named in this document is a LIVE value there — this page explains
the mechanism, it does not restate today's modes.

---

## 1. The registry (24 purposes)

Tier rule (`ROLLOUT_TIER_RULE`, stated once): **tier 1 purposes flip to act
automatically on a fresh measured READY stamp; tier 2 are reported ready to the
owner as one question; tier 3 are never flipped automatically.**

| Purpose | Tier | Decides | Act does | Harness label |
|---|---|---|---|---|
| `wake_triage` | 1 | does this hook-event group need a supervisor turn now? | parks a non-alarm hook wake ≤ 30 min, then delivers; one confident park in 10 DELIVERS as a control (`control:true`) | the wake ran an evidence-bearing tool / mutating call (finalize); a park is never labelled, so the sampled control wakes are the act band's own labels |
| `sweep_triage` | 1 | would this scheduled sweep be a no-op? | skips a no-op stock sweep tick; heartbeat floor still fires; one confident-quiet skip in 10 FIRES as a control (`control:true`) | the fired sweep took a recorded action; heartbeat + sampled control turns are the act band's own labels |
| `imessage_send` | 1 | is the user asking to SEND an iMessage now? | skips the send-intent utility call | the utility call / the confirm card |
| `auto_route` | 1 | which preset should a mode=auto send run? | picks Level 1 / 2 / 3 instead of the regex | the picked-level window + the Dig-deeper tap |
| `browser_driver` | 1 | cloud read, paired Mac or computer use? | routes from the gate (availability gates first) | the reasoning call's pick / session outcome |
| `memory_extract` | 1 | anything durable to extract this turn? | skips an extractor | did the extractor change the stored doc |
| `delta_material` | 1 | is the probe change material? | skips a delta-gate schedule fire | the fired run took a recorded action |
| `checker_route` | 1 | where does the Level 2 checker sit? | 75 s path at effort high vs the full wait — the checker never skips | what the turn did vs the regex |
| `coding_memory_fold` | 1 | anything worth folding after a coding run? | skips a memory / journal leg (τ 0.9 since 2026-09-28; the state carries doc sizes + last-fold ages) | did the leg change the stored doc |
| `reflection_route` | 1 | which remedy on a 3× tool-failure streak? | skips the 45 s Double-Checker consult unless needs_diagnosis | the consult's remedy / the next tool call |
| `claim_evidenced` | 1 | is each mined action claim receipted? | skips the utility-LLM claim extraction | the verifier's verdict per claim |
| `drain_triage` | 2 | ack_only / coalesce / act_now on a queued agent batch? | parks a quiet batch ≤ 15 min | the drained turn took a recorded action — **act-capped in code** (43 % act agreement) |
| `guard_strike` | 2 | true fabrication or false conviction? | writes a verdict past the nightly reasoning cap | the reasoning adjudicator's verdict |
| `firing_superseded` | 2 | did the lane-holding run already do this firing's work? | drops / folds a busy-parked machine firing | did the fired run do real work — asked for EVERY eligible parked row since 2026-09-28 (a sibling stash beside a delta / sweep stash; the old call-site guard had starved it to zero rows) |
| `wake_effort` | 2 | how much deliberation does this wake need (0–2)? | runs a low-score wake at effort high instead of max | harness-counted evidence calls; `DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0` hard-disables — **lifecycle: shadow** (AUROC 0.541; re-pose candidate, §1a) |
| `compute_policy` | 2 | depth / stakes / live-web / research at send | skips the Double Checker on a low-stakes simple lookup; stakes wait ≤ 90 s | Dig-deeper tap / 30-min window closer / finalize facts; supervisor + machine turns get the closer's `machine` harness-proxy row (pill updated or ≥ 3 lead tool calls ⇒ contestable, 1–2 ⇒ ordinary, none + short ⇒ simple_lookup; excluded from the fit until 30 rows exist) |
| `drafts_agree` | 2 | do the lead final and the checker draft agree? | skips the reconcile, marks Checked | the reconcile's revision_material verdict |
| `revision_material` | 2 | did the reconcile change a claim, or only wording? | marks a wording-only reconcile Checked with no rewrite | thumbs / escalation after the revision (`human`, primary); else the window closer's `harness` row from the deterministic diff verdict (diff ⇒ material, fallback ⇒ wording-only, gate ⇒ acted + excluded) |
| `supervisor_turn_noop` | 2 | will this sweep / drain turn take a recorded action? | skips a sweep / parks a drain (heartbeat floor); replaces sweep_triage + drain_triage at its sites | a mutating platform tool call; **control-gated** (30 floor turns ≥ 0.95) |
| `session_topology` | 2 | where does this coding request belong — spawn / reuse / merge / retire? | on the ambiguous R7 band a confident reuse / merge / retire replaces the fail-open spawn (spawn is never acted on; R1 / R4 refusals still need `SESSION_TOPOLOGY_ENFORCE=1`) | +24 h placement label from the `session-topology-outcomes` cron (spawn: mutating receipt ≤ 10 min; reuse / merge: the target lane minted one, no duplicate lane; retire: 72 h silence) |
| `turn_plan` | 2 | which lane should answer this human turn — quick / standard / checked / research — plus stakes / live-web / contested / multi-step / breadth (dynamic roster, 2026-10-03)? | a confident QUICK lane under the stakes / contested ceilings (`quick-lane-guards.ts`) on a short, attachment-free, non-code human turn runs the Quick answers seat (web search, thinking off, ≤ 4 steps, no checker); every other lane and the would-be roster are recorded only; its non-act answers (lane, traits) also feed the lane-depth / model-pick consumers under their own store flags (`instance:turn-plan/config`) | the Dig-deeper tap ≤ 30 min (needed the next lane up) or the 30-min window close (the lane held) — primary; re-ask ≤ 5 min and thumbs are secondary rows (`chat-agent/turn-plan-labels.ts`) |
| `self_audit` | 3 | does the coding final claim unevidenced work? | retired as an act consumer — the deterministic receipt rule owns the site; **act-capped** (AUROC 0.232) | any_reopen at the run finalize — **lifecycle: shadow_review by 2026-10-12** (§1a) |
| `tool_intent` | 3 | which offered tool did the narration intend? | nothing — no act consumer; **RETIRED** (`PURPOSE_RETIRED`: bare default off, act refused) | the regex detector + the next tool call — **lifecycle: retire** (§1a) |
| `task_kind` | 3 | what JOB is this human turn — writing / code / analysis / lookup / advice / planning / explain (both option orders, averaged; task-aware pick, 2026-10-20)? | nothing in the gate — no gate act consumer; **act-capped** (a pure evidence key, never retired): a calibrated kind at p ≥ 0.5 keys the per-turn model pick's QUALITY evidence by (model, kind) before (model, lane); whether that kind-aware pick leads is the `modelPickKind` store mode on `instance:turn-plan/config` (off / shadow / act); fail-open = (model, lane) evidence | no outcome label writer yet — the model bench's title-kind vs plan-kind agreement is the readout — **lifecycle: shadow** (§1a) |

Per purpose the registry additionally carries: the consumer site
(`file:function`), the act question + shape + default threshold (from
`ACT_POLICIES`), the readiness bars (`readinessBarsFor` — a base of 200 labels / 3 d /
band n ≥ 20 at precision ≥ 0.9 / AUROC ≥ 0.8 / coverage@5% ≥ 0.6;
`supervisor_turn_noop` 30 band rows ≥ 0.95 + the control gate; `session_topology` 30 band rows ≥ 0.95), the act cap
(`PURPOSE_ACT_CAPS` with its lift env), the retirement (`PURPOSE_RETIRED` with its lift env),
the lifecycle decision (§1a), the kill switches and the owner lock.

**Volume-scaled label floor (2026-09-28, `READINESS_VOLUME_RULE`):** the 200-label
floor inside a 14-day window was unreachable for any purpose under ~14 labels/day,
so the floor a purpose must clear is now `clamp(10 × its observed labels/day, 50,
its base floor)` — ten days' worth of its own labels, never under 50 (a purpose
with no labels keeps the base). A near-degenerate label set (one class under 5 %
of n, with at least one row) is judged on the Wilson-LB precision bar alone (the
AUROC / coverage bars need both classes); a set with NO minority row keeps the
"AUROC n/a" missed bar (a label writer that never fires). Every other bar is
unchanged. The registry row's `bars` shows `minLabelsFloor` / `volumeScaleDays` /
`volumeRule`; `DECISION_GATE_READINESS_VOLUME_SCALED_DISABLED=1` restores the fixed
bar — this is a loosening of the owner-set bar, flagged as such when it shipped.

### 1a. Registry lifecycle decisions (2026-09-28)

A purpose whose readout says "do not simply wait for READY" carries ONE decision
in its registry row (`lifecycle`), read by the automaton, the admin table and this
playbook alike — never a store value:

| Purpose | Decision | Why | What it does |
|---|---|---|---|
| `tool_intent` | **retire** | the best-calibrated purpose (AUROC 0.934, band 266/269) with no act consumer and none planned; it was 70 % of all gate calls | `PURPOSE_RETIRED`: bare default mode `off` (source `retired_default` — an explicit env / store row / `DECISION_GATE_DEFAULT_MODE` still governs), act-capped (the PUT refuses act), the row and its history stay; `DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED=1` lifts for a comparison run |
| `self_audit` | **shadow_review** until 2026-10-12 | the v2 re-pose reads AUROC 0.516 on n=85 (chance) while the deterministic receipt rule already owns the site; ~1.4k Jev calls a week | stays shadow; by the review date it must show v2 AUROC ≥ 0.6 on ≥ 200 labels in the newest partition, else the store mode goes `off` and it joins `PURPOSE_RETIRED` |
| `wake_effort` | **shadow** | AUROC 0.541 / band LB 0.453 on the harness-counted label — the score does not predict what the wake does; an act consumer EXISTS (`platform/wake-effort.ts`), so this is a predictiveness problem, not a consumer gap | stays shadow; next step = re-pose to `supervisor_turn_noop`'s `will_act` noul over the target record (its own questionsHash partition) judged on the same harness label |
| `task_kind` | **shadow** (2026-10-20) | a pure evidence key for the task-aware model pick — the ask must keep running in prod (never retired) so the kind reaches `metadata.depth.turnPlan.taskKind`; there is no outcome label writer yet, so readiness reads "no labelled outcomes" | stays shadow and act-capped (`PURPOSE_ACT_CAPS` — the PUT refuses act, the automaton skips it, no tier-3 owner question); next step = a label writer (e.g. the nightly live-chat audit judging the kind on sampled turns); `TASK_KIND_DISABLED=1` stops the ask |

### Why the tiers

- **Tier 1** — act only REMOVES bounded harness work behind a heartbeat or
  deadline floor: a parked wake is re-delivered, a skipped extractor loses at
  most one fold, a routed level keeps the presets as the fail-open. A wrong act
  costs a delay and shows up as an auto-demote.
- **Tier 2** — act touches what a human reads or a lane's cadence in a way a
  delay does not undo (an unreconciled answer marked Checked, a wake at lower
  effort, a dropped firing, a written verdict), or the purpose is control-gated
  / capped and a human should read the readout first.
- **Tier 3** — no act consumer, or the consumer was retired for a
  deterministic rule; flipping is meaningless or already superseded.

Changing a tier is a code change to the registry row (with its `tierWhy`) —
never a store value — so the reasoning travels with the decision.

---

## 2. The flip lifecycle

```
 shadow ──(readiness cron stamps READY, measured)──▶ READY
   ▲                                                  │
   │                              tier 1: automaton flips │ tier 2: ONE owner question → 'flip' answer
   │                              (admin PUT admission)   │ tier 3: informational question only
   │                                                  ▼
   └──(auto-demote: act-period Wilson UB < bar)──── act
   │
   └──(2 auto-demotes in 7 d)──▶ parked 7 d ──(expires)──▶ shadow
 off ── never touched by the automaton (a human sets off / clears it)
```

1. **shadow → READY.** The worker cron `decision-gate-readiness` (every
   `DECISION_GATE_READINESS_INTERVAL_MIN`, 360) stamps every purpose from the
   window's `decision_gate` rows (`instance:decision-gate/readiness`). A stamp
   is MEASURED when `backend` names a real backend and `metrics.n` clears the
   purpose's label bar; an owner-override stamp (`backend` ~ owner/override/
   manual, no labels) is never a rollout input.
2. **READY → act.** The cron `decision-gate-rollout` (`platform/
   decision-gate-rollout.ts`, every `DECISION_GATE_ROLLOUT_INTERVAL_MIN`, 60,
   judging each readiness report ONCE) flips every tier-1 purpose whose stamp
   is fresh + measured, that is not act-capped, not parked and not off, by
   calling `updateDecisionModes({purpose:'act'}, 'auto-rollout')` — the SAME
   function the admin PUT calls, so `PURPOSE_ACT_CAPS`, the READY stamp, the
   primary-backend pin and the control gate are never bypassed. One
   `loop_metrics decision_gate_rollout {purpose, from, to, reason, bars}` row
   per action; the ledger at `instance:decision-gate/rollout`.
3. **act → shadow (auto-demote).** Unchanged: `decision-gate-modes.ts`
   demotes when n_act ≥ 30 and the Wilson 95 % upper bound of the act-period
   precision is below the bar. The automaton never removes act.
4. **parked.** Two `decision_gate_demoted {outcome:'demoted'}` rows for one
   purpose inside 7 d park it for 7 d (`parked_until`); the automaton skips
   it, the prompt layer and the briefing name it. Parking expires on its own.
5. **Tier 2 / 3 READY.** ONE owner question per purpose (`flagOwnerQuestion`
   on the admin owner's Fleet Supervisor chat, machine-triggered so the topic
   dedupe and the supervisor-first triage apply); no repeat while the question
   is open. A tier-2 question answered 'flip' (typed option or the standing
   proceed words) flips on the next pass with reason `owner_answered`; a hold
   closes the ask; a tier-3 question is informational — never flipped here.
6. **Inconsistencies.** A store row that says act for a purpose the code caps
   at shadow (`drain_triage`, `self_audit` today) is REPORTED (ledger,
   briefing, `get_decision_gate_status`, the admin badge) and never rewritten
   — the human sets it to shadow by hand for coherence.

---

## 3. Who flips what

| Actor | Can | Cannot |
|---|---|---|
| **Rollout automaton** (cron) | tier-1 shadow → act on a measured READY stamp; park after 2 demotes; file / close the tier-2/3 owner ask; flip a tier-2 purpose on the owner's 'flip' answer | remove act; touch an off purpose; bypass a cap, a stale stamp or a primary mismatch; rewrite a store/code inconsistency |
| **Fleet Supervisor** (`set_decision_gate_mode`) | shadow / off / clear on any purpose; act on a tier-1 purpose (same admission); on a tier-2/3 purpose from a machine turn: file ONE owner question and re-call with `ownerQuestionId` once answered 'flip' | flip a purpose the readout does not show READY; "fix" a parked or skipped wake by flipping (rule gate.outcome) |
| **Owner / admin** (panel or `PUT /admin/model-roles/decision-modes`) | anything the admission admits; the automaton switch (`PUT /admin/model-roles/decision-rollout {enabled}`, `PUT /admin/settings/decision_gate_auto_rollout`); lift a cap by env on every box | admit act without a READY stamp (unless `DECISION_GATE_ADMISSION_DISABLED=1`) |
| **Auto-demote** | act → shadow on a confident precision breach | anything else |

Every flip lands in the same places: the store row `instance:decision-gate/
modes` (`updatedBy`), a `decision_gate_rollout` loop-metrics row (automaton +
tool) or the admin audit, the rollout ledger, the owner briefing head line
("Decision gate (auto-rollout ON): …"), and the framework-facts prompt layer on
the next composed supervisor prompt.

---

## 4. Adding a new purpose — the checklist

1. **Question** — add the `DecisionPurpose` member (`decision-gate.ts`) and
   the `DECISION_PURPOSES` label / description (`decision-gate-modes.ts`).
2. **Consumer** — the gated site calls `decide()` and acts ONLY on
   `result.mode === 'act'` (fail-open on off / uncalibrated / error), behind a
   per-site kill switch.
3. **Label** — the harness (never the model's own claim) writes the outcome
   row's `actual` + `agreed` at the natural close (`decision-outcome-labels.ts`).
4. **Readiness partition** — an `ACT_POLICIES` entry (`decision-gate-fit.ts`:
   question, kind, threshold, consumer) so the ruler computes the act band at
   the real cutoff; per-purpose bars in `PURPOSE_READINESS_BARS`; add it to
   `PURPOSE_CONTROL_GATED` if the act period produces floor turns.
5. **Registry row** — `DECISION_ROLE_REGISTRY` in `decision-gate-registry.ts`:
   decides / consumerSite / actDoes / harnessLabel / killSwitches / ownerLock /
   tier + tierWhy. `decision-gate-registry.test.ts` fails until it exists.
6. **Doctrine** — nothing to add for the purpose itself (the facts layer
   composes the lists live); if the site adds a platform TOOL, give it a
   doctrine row (`doctrine-coverage.test.ts`).
7. **Docs** — `.env.example` (the site's switches), an AGENTS.md bullet, and a
   row in the table above.

---

## 5. Backends and challengers

The automaton is backend-agnostic: it reads the stamp the readiness cron wrote
for the purpose's CONFIGURED primary (`decision-gate-backends.ts` — TypeSafe
Jev built-in `jev` today, `cql-litellm:agx-laya` as the `systemone_chat`
challenger, the `deepseek-flash` logprob readout as the uncalibrated fallback).
A stamp measured on another backend refuses admission ("readiness measured on
X, primary is Y") until the next readiness pass re-stamps the primary; a
primary change on an act purpose drops it to shadow on the PUT — and the
automaton then re-flips it only once the new primary has its own measured
READY. Challengers never answer and never feed the automaton; promote one in
the backends panel and the same lifecycle applies.

---

## 6. Kill-switch map

| Switch | Effect |
|---|---|
| SystemSetting `decision_gate_auto_rollout` = `0` (panel / PUT) | the automaton evaluates nothing (ledger notes "OFF") |
| `DECISION_GATE_AUTO_ROLLOUT=0` | env boot default OFF (the row wins when set) |
| `DECISION_GATE_AUTO_ROLLOUT_DRY_RUN=1` | records + logs would-be flips, writes no mode |
| `DECISION_GATE_ROLLOUT_JOB_DISABLED=1` | the cron computes nothing |
| `DECISION_GATE_ROLLOUT_INTERVAL_MIN` | cadence (15..10080; each readiness report judged once) |
| `DECISION_GATE_ADMISSION_DISABLED=1` | (pre-existing) the PUT — and therefore the automaton — admits act without a stamp: never set it with the automaton ON |
| `DECISION_GATE_AUTO_DEMOTE_DISABLED=1` | (pre-existing) breaches observed, never demoted — the automaton's park signal goes quiet too |
| `DECISION_GATE_<PURPOSE>_ACT_CAP_DISABLED=1` | (pre-existing) lifts a code cap on that box |
| `DECISION_GATE_READINESS_JOB_DISABLED=1` / `_STAMP_DISABLED=1` | (pre-existing) no fresh stamps → the automaton has nothing to act on |
| `FRAMEWORK_FACTS_DISABLED=1` | (pre-existing) the prompt layer (with its roll-out line) is omitted |
| `DECISION_GATE_DISABLED=1` | (pre-existing) no gate call anywhere |
| `DECISION_GATE_SPEND_ROWS_DISABLED=1` | (2026-09-28) no run_spend / run_tokens rows from the gate — the API-costs block goes dark for new calls; decision_gate rows untouched |
| `TYPESAFE_USD_PER_MTOK_IN` / `_OUT` | (2026-09-28) override the Jev list price the spend rows are minted at (rows say `priceSource:'env'`) |
| `COMPUTE_POLICY_MACHINE_LABEL_DISABLED=1` / `_MIN_ROWS` | (2026-09-28, DOI-21) no `machine` harness-proxy row for supervisor / machine compute_policy decisions; the ramp before those rows enter the fit (30) |
| `REVISION_MATERIAL_HARNESS_LABEL_DISABLED=1` | (2026-09-28, E10) the window closer writes no revision_material `harness` row (human rows only) |
| `DECISION_GATE_FIRING_SUPERSEDED_SIBLING_DISABLED=1` | (2026-09-28, E09) the parked-firing gate is asked only when no delta / sweep stash rides — the pre-change guard that never asked |
| `DECISION_GATE_READINESS_VOLUME_SCALED_DISABLED=1` | (2026-09-28, E11) the fixed 200-label floor + unconditional AUROC / coverage bars |
| `DECISION_GATE_SWEEP_TRIAGE_CONTROL_RATE` / `SWEEP_TRIAGE_CONTROL_SAMPLE_DISABLED=1` | (2026-09-28, E12) the share of confident-quiet act skips that fire as controls (1/10) / none |
| `DECISION_GATE_WAKE_TRIAGE_CONTROL_RATE` / `WAKE_TRIAGE_CONTROL_SAMPLE_DISABLED=1` | (2026-10-04) the share of confident-quiet act wake_triage parks that deliver as controls (1/10) / none — park every time; both control pairs are forwarded by compose to both services |
| `DECISION_GATE_TOOL_INTENT_RETIRE_LIFTED=1` | (2026-09-28, E13) lifts the registry retirement on that box (the act cap keeps `DECISION_GATE_TOOL_INTENT_ACT_CAP_DISABLED`) |
| `CODING_MEMORY_FOLD_STATE_FACTS_DISABLED=1` / `DECISION_GATE_THRESHOLD_CODING_MEMORY_FOLD=0.8` | (2026-09-28, E14) the pre-change fold-gate state / the old 0.8 cutoff at the site and in the ruler |
| `DECISION_GATE_STATE_SAMPLE_RATE=0` / `_DISABLED=1` | (2026-09-28, CT-9) the sampled decision-state corpus off (default 0.05, wake_triage 0.2; rows only, no spend); forwarded by compose to both services |
| `TASK_KIND_DISABLED=1` | (2026-10-20, task-aware pick) no `task_kind` ask at all — the pick keeps today's (model, lane) evidence; the consumer's own switches are `MODEL_PICK_KIND_DISABLED=1` (no kind-aware pick) and `MODEL_EVIDENCE_KIND_DISABLED=1` (evidence ignores kind buckets); all three forwarded by compose to both services |

---

## 6a. Cost — what the gate spends, where it shows, how it is priced (2026-09-28)

Owner 2026-09-28: "did you make sure to add jev to api costs as well" — it had
not been. 13,743 `decision_gate` rows carried 12.27M input tokens in 24 h and
NO `run_spend` / `run_tokens_*` row named a decision backend, so Account →
Admin → API costs showed nothing for Jev.

**Write side** (`platform/decision-gate-pricing.ts`, called from
`recordDecisionRow` in `decision-gate.ts`): every ANSWERED call — the primary
leg (whichever leg in the chain answered, so a fallback to the DeepSeek
readout is priced as the readout), every challenger (`meta.challenger:true`),
the admin probe — mints `run_tokens_in` (the backend's reported usage, else
the prefill's own ~4 chars/token estimate with `estimated:true`),
`run_tokens_out` when > 0 (Jev answers with 0; the readout spends one token
per question) and ONE `run_spend` row: `meta.profile='decision'`,
`meta.model` = the backend's model id (`jev-1.13.0` — the id the server
ANSWERED with; `cql-litellm:agx-laya`; `deepseek-flash`), `meta.purpose`,
`meta.backend`, `meta.backendSpec`, `meta.decisionId` (idempotency key),
`meta.priceSource`, `meta.usdPerMTokIn/Out`, `meta.unpriced` when nothing
prices it. `runId` = `dg-<decisionId>`; `sessionId` = the chat / run the
decision served (`DecideOpts.sessionId`) else the synthetic `decision-gate`
session (excluded from the per-user rollup). Memo hits mint nothing — no
backend was called.

**Prices:**

| Backend | Price | Source |
|---|---|---|
| TypeSafe Jev (`jev`) | $0.042 / M input, output not metered | vendor list price, https://docs.typesafe.ai/models ("$42 per billion input tokens", fetched 2026-09-27); `TYPESAFE_USD_PER_MTOK_IN` / `_OUT` override |
| a registry backend (`<label>:<modelId>`, e.g. Laya on `cql-litellm`) | the model entry's `usdPerMTokIn/Out`, else the endpoint's `settings.usdPerMTokIn/Out` (Account → Admin → Endpoints: "$/M in / out" on the model row, "Price … (endpoint default)" on the endpoint) | `priceSource:'registry'`; unset = **$0 badged "self-hosted"** (`priceSource:'self_hosted'`, `unpriced:true`) — never a silent list-price guess |
| the DeepSeek logprob readout (`deepseek-flash`) | $0.15 / M in, $0.60 / M out | `coding/cost.ts` PRICES (already the chat / coding table) |
| anything else | $0, `priceSource:'unpriced'` | the panel says "unpriced" |

**Read side** (`platform/decision-gate-spend.ts`): Account → Admin → API costs
→ "Decision gate" block — calls (decision rows, memo hits excluded and shown
separately), input tokens, $ per backend and per purpose, p50 latency, the
"N of M calls priced" gap (history the backfill has not minted), and a "what
it replaced" ESTIMATE for the act purposes that remove work: `wake_parked`
reason `triage` (wake_triage) × the mean `run_spend` of hook-triggered runs in
the window; `schedule_sweep_skip` (sweep_triage) and `wake_parked` reason
`turn_noop` (supervisor_turn_noop) × the mean of schedule-triggered runs —
labelled an estimate, never a saving claim. The per-model table lists the
decision backends in their own group (a `deepseek-flash` readout row never
merges with the Double Checker's). `GET /admin/model-roles/decision-registry`
rows carry `calls24h` / `costUsd24h` / `pricedCalls24h`, rendered as the "24 h"
column of the registry table next to the mode.

**Backfill** (history before the 2026-09-28 deploy — APPLIED 2026-09-28, a41ad6ba
live 03:33Z: 13,340 `run_spend` rows carry `meta.backfill`; verified read-only
2026-09-28 20:09Z — 16,229 decision-profile rows, $0.8655 total, Laya rows
unpriced by owner decision "laya leave $0"; re-runnable, idempotent): on box A,

```
bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-decision-gate-spend.js            # dry run: counts per backend / purpose + the USD it would mint
bash /opt/crossmodel/scripts/framework-audit/prodq.sh backfill-decision-gate-spend.js --apply    # mint run_tokens_in + run_spend for the last 14 d (--days N ≤ 30, --limit N, --batch N)
```

It reads every `decision_gate` row (phase `decision`, ok, not a memo hit) that
carries `meta.inputTokens` (5,799 of the 13,743 rows in the 24 h probe — the
rest were the readout / rows the backend answered without usage; they are
counted as `skippedNoUsage`, the stored row has no prompt size to estimate
from), prices it with the SAME `decision-gate-pricing` module the container
serves, stamps `createdAt` = the decision row's own time and `meta.backfill =
<run id>`, and skips any decision id that already has a `run_spend` row —
re-running is safe. It never mints `run_tokens_out` (the readout's
per-question output is not on the stored row).

**Kill switch:** `DECISION_GATE_SPEND_ROWS_DISABLED=1` (no new spend rows; the
panel shows a banner). Tests: `platform/decision-gate-pricing.test.ts`,
`platform/decision-gate.spend-rows.test.ts`, `platform/decision-gate-spend.test.ts`,
`scripts/backfill-decision-gate-spend.test.ts`.

---

## 7. How this session's rollout loop is now the framework's job

Until this change the loop lived in a human session: read the readiness
readout, call the admin PUT for a purpose whose bars held, watch the
auto-demote window, write the state into CLAUDE.md. Each of those steps now
has an owner inside the framework:

- **read the readout** → the readiness cron stamps; the automaton reads the
  stamp and the modes view;
- **decide which to flip** → the registry's tiers (a code review decision,
  once) + the measured-stamp rule;
- **flip** → `updateDecisionModes` through the same admission;
- **monitor** → auto-demote + the park rule; the ledger + `decision_gate_rollout`
  rows; the readiness cron re-stamps every 6 h;
- **tell people** → the owner briefing head line, the framework-facts layer
  in every supervisor prompt, the Fleet Supervisor's `get_decision_gate_status`,
  the admin registry panel;
- **write it up** → this playbook explains the mechanism; the live state is
  the registry endpoint, so no dated "state as of" paragraph needs maintaining.

What stays human: tier-2 answers (one question each), lifting a code cap,
changing a tier, promoting a backend, and turning the automaton off.
