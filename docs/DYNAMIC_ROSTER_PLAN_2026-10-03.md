# Dynamic model roster for Auto chats — audit, options, plan (2026-10-03)

Owner ask (2026-10-03): move Auto chats from the fixed presets 1 / 2 / 3 to a
fluid pathway where the decision model (Jev) reads the first message, decides
which agents to spawn for the session from ANY model configured under
Account → Admin → Endpoints, and adds or removes agents as the session grows —
"what's the weather" → a fast helper (Qwen 3.8 Flash / 27B + web search);
"explain why Canadians are for or against Quebec sovereignty" → deep research.

This doc is the audit that preceded it, the options, and the phased plan.
**Status (2026-10-03, evening): the owner chose option B** — the Quick lane
runs thinking OFF, the auto-picker uses OPEN models only, and the router learns
from taps / re-asks / thumbs / offline replays (no live exploration). Phases 0–2
are live (the classifier in SHADOW); the Quick lane is hardened from replay data
and verified on a canary. **§7 is the live progress log** — read it first.

## 1. What production does today (prod readout DR1003, 2026-10-03 18:53Z)

Window: human answers on non-supervisor chats since `metadata.depth` began
(2026-09-26) — 89 rows, 2–22 a day. Guests leave no rows (Redis sessions).

| Level (how it was chosen) | n | first token p50 / p90 | done p50 | $ / turn (avg) |
|---|---|---|---|---|
| L1 single_thinking (keyword router) | 15 | 163 s / 385 s | 175 s | 0.13 |
| L1 (gate-routed, while auto_route was in act) | 6 | 70 s / 163 s | 75 s | 0.14 |
| L2 thinking (keyword router) | 55 | 230 s / 736 s | 349 s | 0.23 |
| L3 deep_research (keyword router) | 5 | 942 s / 1,370 s | 1,157 s | 0.54 |
| Dig deeper → research rung | 2 | 1,168 s | 1,186 s | 0.24 |

- **Every** answer ran the same lead: `cql-litellm:api-optimize-zai-glm-5.3-flash`
  (the `chat_orchestrator` seat), at max reasoning (custom endpoints get `max`
  since 2026-09-29; the 'high' human-turn override only applies to built-in
  glm / deepseek seats). A "what's the weather" question costs ~3 minutes.
- Checker: gateway `deepseek-v4.1-flash` (49) / direct `deepseek-flash` (11).
  The check pill ended `updated` 33×, `checked` 24×.
- Modes (store row, 2026-09-28 02:39Z): **auto_route = shadow** — the keyword
  router alone picks the level today. compute_policy / drafts_agree /
  revision_material = shadow. `patience_auto_only = 1`.
- Jev latency is fine: compute_policy p50 192 ms / p95 314 ms (2,327 asks in 7 d,
  33 timeouts at the 1.2 s bound); auto_route p50 176–214 ms.
- Jev's **confidence is not**: 331 of 386 human compute_policy `depth` answers
  sit below 0.70 (most near-uniform, e.g. 0.42 / 0.25 / 0.19 / 0.14); `stakes`
  crossed 0.85 once in 386. auto_route: 247 of 323 below 0.70. As posed today
  the questions rarely clear an act threshold.
- The registry holds one endpoint (`cql-litellm`, llm.cql.ca) with ~45 models:
  open (glm-5.3 / -flash, kimi-k3, deepseek v4-pro / v4.1-flash, qwen3.8
  flash / max / open / 27B / flash-next, mimo-v26-flash-rl, spark-qwen3-4b-helper),
  frontier (Claude Fable 5 / 5.1, Opus 4.8 / 5, GPT-5.5 / 5.6 sol / luna / terra,
  GPT-6 astra, Grok 4.3–4.7), plus embed / rerank / ASR / image / Laya. Almost
  none carry a price, kind or capability card.

Older baselines (DEPTH_UX_SOTA §2, 14 d): L1 / L2 / L3 completion p50 131 / 281 /
1,473 s; re-ask within 5 min 24 / 23 / 20 %.

## 2. Audit findings

### Fixed in Phase 0 (this change; each has a kill switch in `.env.example`)

1. **Queued Level 3 ran unmetered.** A busy chat queued the routed
   `deep_research` before the quota reserve; the drain started it with no
   reserve. Now the slot is reserved at enqueue (an Auto L3 that loses it is
   queued as Ensemble, an explicit one errors like the direct path), a lost
   start race never charges twice, a failed enqueue refunds.
   `QUEUED_COUNCIL_QUOTA_DISABLED`.
2. **Weak research words convened the council.** "what is the *source* of the
   Nile?", "open *source* alternative to Photoshop", "the *latest news* about the
   Fed", "can you *cite*…", "what does the *research* say" → a 20-minute council +
   a quota slot. Live, because auto_route is in shadow. Research REQUESTS ("Research
   X", "can you research", "do some research", "deep research", "literature
   review", "comprehensive analysis"…) still route to L3.
   `AUTO_ROUTE_RESEARCH_CUE_SPLIT_DISABLED`.
3. **Guests blocked up to 300 s on the checker** (≈40 % of plain human turns).
   The design promised 75 s; the cap only applied to regex-"simple" messages.
   Now 75 s. `GUEST_CHECKER_GATE_BOUND_DISABLED`.
4. **The stakes / Dig-deeper "verify" wait was skipped when the lead answered at
   step 0** — the wait lived only in the step injector. Finalize now owes it.
   `STAKES_FINALIZE_WAIT_DISABLED`.
5. **Council naming mismatch.** The lead's prompt named the colleagues
   'deepseek' / 'glm'; `dispatch_colleagues` / `send_note` accept only the seat
   keys; a refused dispatch still spent one of the 4 rounds; a note to an unknown
   recipient reported "delivered". Aliases + validate-before-count + honest note.
6. **Dig deeper wrote labels before the access check** (any signed-in user with
   a chatId + messageId could label another user's decision) and a hand-built
   tap could run the council on a supervisor chat. Access first; supervisor
   chats refused.
7. **Stale chat prompt:** it said `start_coding_session` / `create_feed` /
   own-chat schedules are confirmation-gated; since 2026-09-28 they run directly
   on a human turn.
8. **None of the depth / routing kill switches reached prod**
   (`COMPUTE_POLICY_DISABLED`, `ANSWER_FIRST_DISABLED`, `DIG_DEEPER_DISABLED`, …):
   `docker-compose.app.yml` lists env vars explicitly and none were listed. 19
   boolean flags are now forwarded (backend + worker). Numeric knobs
   (`STAKES_WAIT_MS`, thresholds) stay unlisted until their parsers treat blank as
   unset.

### Deferred into the redesign (dormant or design-level)

9. auto_route outcome rows are labelled with the **keyword router's** level, so
   an act-mode gate is graded against the regex it replaces (its 0.402
   "agreement" is disagreement with the regex, not error).
10. compute_policy in act could never record a failure: the tap label omits
    `acted`, the window closer labels untapped acted decisions as correct, and the
    purpose is exempt from auto-demote. Dormant while shadow.
11. `leadEffort` is a label, not a control (custom endpoints always run max).
12. Up to four Jev asks per L2 human turn (auto_route, compute_policy after the
    context load, checker_route with the same questions, drafts_agree), partly
    serial.
13. The keyword L1 ignores stakes ("ibuprofen with warfarin" → one model, no check).
14. `priorRung` / `priorEscalations` are documented gate inputs no caller passes.
15. Late reconcile / escalation stamps read-modify-write the row without a
    compare-and-set (plausible lost update).
16. Cleanup: `council:'background'` has no consumer; images counted twice in
    `attachment_count`; a reserved slot is not refunded when the run fails to
    start; `normalizeDepthPreset` vs `storedModeToPreset` disagree on unknown modes.

## 3. What the research says (sources in the session briefing)

- **TypeSafe Jev**: still `jev-1.13.0` (no newer model, no fine-tuning). The API
  takes many questions per call — batching 13 questions cost 12× less and ran 10×
  faster than separate calls. Choice options can carry description cards
  (`what` / `not_for` / `examples`). Weak spots TypeSafe and third parties
  document: position bias, sensitivity to option NAMES (renaming flipped up to
  ~70 % of answers in one study), steerable by injected text, per-task
  calibration error ≈ 0.17. Practical read: Jev is a fast classifier, not a judge
  of which of 40 models is best.
- **Routers that work in production** separate *policy* from *model*: classify
  the request into a small set of stable routes, then map routes to models in
  config (Arch-Router; OpenRouter's auto router; GPT-5's router routes on
  "conversation type, complexity, tool needs, and explicit intent" and learns from
  model switches, preferences and correctness). Cascades (cheap first, escalate
  on evidence) are the best-evidenced cost saver.
- **Team size should follow breadth, not difficulty**: independent sub-questions
  parallelize well (≈ +81 %); sequential reasoning gets worse with more agents.
  Anthropic's effort-scaling rule — 1 agent / 3–10 tool calls for fact-finding,
  2–4 sub-agents for comparisons, 10+ for broad research. A central checker
  contains error amplification.
- **Mid-session**: add/remove helpers rather than swapping the lead (swapping
  the lead or its effort invalidates the prompt cache). Per-turn re-routing with
  few switches beats static routing (MTRouter 2026).
- **Cold start**: Dig-deeper taps / re-asks / switches are usable reward but
  noisy; log the decision probabilities so other policies can be evaluated
  offline; LLM-judge labels cut the label requirement; new models get a capability
  card from a small measured probe set, not from marketing.

## 4. Options

All options keep: answer-first, Dig deeper, Auto as the default, the kids path,
machine rails, seats for every model call, a kill switch per change, shadow
before act, fail-open to today's presets.

### A — Quick lane only (smallest)
Add a fifth shape in front of L1: **Quick** = the Helper seat (qwen3.8-flash
today) with web tools, thinking off, ≤ 4 steps / ~90 s, no checker. Picked by
the existing router when the message is a simple / live-web lookup; Dig deeper
climbs Quick → Checked → Research.
- Wins: weather / scores / prices / definitions drop from ~3 min to tens of
  seconds (search latency dominates — BrightData SERP is 3–20 s).
- Leaves: still three fixed tuples, no model choice, no session memory.
- Effort: ~2 days.

### B — Lanes + model pools + session roster (recommended)
1. **One batched Jev call per human turn** (new purpose `turn_plan`), fired in
   the controller in parallel with the context load, replacing the
   auto_route + compute_policy + checker_route asks: `lane` choice over
   {quick, standard, checked, research} with description cards, plus nouls
   `needs_live_web`, `stakes`, `contested`, `needs_reasoning`, `follow_up`, and a
   `breadth` score 1–4. Asked twice with reversed option order and averaged
   (position bias). State: message, last two user turns, prior lane, turn index,
   attachment kinds — never tool output or documents (injection).
2. **Admin "Auto pools"** under Model roles: an ordered list of models per role
   — quick, lead, checker, colleague — each model with a **capability card**
   (family, tier, vision, context, tool cap, price, measured latency, health,
   `autoEligible`). Defaults come from today's seats, so an unconfigured instance
   behaves exactly as now plus a Quick lane on the Helper seat.
3. **A deterministic roster planner** (pure, unit-tested): lane + nouls +
   session state + pools → `Roster {lead, effort, checkers[], colleagues[],
   helperBudget, waitPolicy}`. Rules, e.g.: stakes ⇒ at least Checked; contested
   ⇒ checker from a different model family; research ⇒ colleagues = breadth
   (2–4); vision ⇒ vision-capable lead; follow-up in a research session ⇒ stay
   Checked unless trivial. Jev classifies; code chooses models — explainable and
   stable when the admin edits the registry.
4. **Session roster**, persisted per chat: re-planned every turn with hysteresis
   (upgrade at once, drop at most one lane per turn, keep the lead model stable
   for cache), so the team grows and shrinks with the conversation.
5. **Mid-turn scaling**: the lead gets a `call_in` tool to add a checker or
   colleague from the pools when the question proves harder than it looked —
   bounded by the existing one-checker / one-council-per-message budget.
6. **Labels with propensities**: Dig-deeper tap / re-ask ≤ 5 min / thumbs-down
   ⇒ under-provisioned; a council or checker that changed nothing material ⇒
   over-provisioned; every decision row keeps the full probability vector and the
   roster actually run.
- Rollout: shadow (log the would-be roster on every turn + an offline replay
  of the last 30 days of human messages with an LLM-judge "minimum sufficient
  lane" label) → act the Quick lane first → research routing (retires the
  keyword L3) → Standard vs Checked → session roster + `call_in`.
- Effort: ~1.5–2 weeks across five phases (below).

### C — Jev picks the models directly
Per-role choice questions over the pool's models (neutral keys, capability
cards in the state, reversed-order averaging) plus a team-size score; the
planner only enforces hard constraints. Closest to the literal ask. Against it:
Jev is weakest at exactly this (option-name sensitivity, low confidence on our
own 4-way question), a 20-option ceiling vs ~45 registry models, every registry
edit resets calibration, and ~11 human turns a day would take months to
calibrate. **Best used as a shadow challenger inside B** until its labels show
it beats the planner.

### D — Agentic self-scaling
Every turn starts on a fast lead with a `call_in` tool and effort-scaling
instructions; it spawns stronger models / colleagues itself as evidence
arrives. Jev only picks the starting lead. Adapts mid-turn, but small models
are poor judges of their own limits (under-escalation), late escalation adds
latency, and behaviour lives in prompts. **B includes D's tool as a supplement**
rather than the primary router.

**Recommendation: B**, with C as a shadow challenger and D's `call_in` as the
in-turn escalation.

## 5. Phased plan for B

| Phase | Ships | Risk control | Status |
|---|---|---|---|
| 0 | The fixes in §2 | kill switch each | **live** — PR #1228 |
| 1 Foundation | model catalog + capability cards; the `chat_quick` "Quick answers" seat (inherits the Helper); admin **Auto pools** (API + panel) | no behaviour change; `AUTO_POOLS_DISABLED` | **live** — PR #1229 (registry prices / `<label>:<id>` spend stamping still open) |
| 2 Classifier (shadow) + Quick runtime | `turn_plan` purpose (one batched ask fired before the context load); the pure roster planner; the plan on every human answer; labels; offline replay | shadow only; `TURN_PLAN_DISABLED`, `QUICK_LANE_DISABLED`, `TURN_PLAN_LABELS_DISABLED` | **live** — PR #1230 |
| 2b Hardening | replay-set guards (p ≥ 0.8, stakes < 0.6, contested < 0.5); code-intent + session-hysteresis guards; the act CANARY; Quick-turn empty answers finish on the Digby seat; lane on the TTFT / fallback rows; the live readout + replay v2 probes | canary only; `TURN_PLAN_CANARY_DISABLED`, the ceiling envs | **live** — §7 |
| 3 Act, lane by lane | Quick lane first (owner flip after the canary readout), then research routing at the controller (quota reserve; retires keyword L3), then Standard vs Checked; auto_route / compute_policy / checker_route asks retire on human turns | per-lane act; readiness + auto-demote on real labels | Quick: awaiting the owner flip |
| 4 Session + mid-turn | persisted session roster with hysteresis (the Quick guard already applies it); the lead's `call_in` tool; a one-line "team" note under each answer (e.g. "Quick · qwen3.8-flash + web") | `SESSION_ROSTER_DISABLED`, `CALL_IN_DISABLED` | next |
| 5 Learning loop | per-model, per-lane win rates feed pool order; C runs as a shadow challenger | no live exploration (owner) | later |

## 6. Decisions for the owner

Answered 2026-10-03: (1) option **B**; (2) Quick lane thinking **off**; (3)
**open models only** — a frontier-class registry model is refused by the Auto
pools and never auto-picked; (5) learn from taps / re-asks / thumbs / replays
only — no live exploration. Default kept: (4) guests may take the Quick lane.

Open:
- **Flip `turn_plan` to act for the Quick lane** (tier 2 — the owner reads the
  canary readout in §7 first). How: Account → Admin → Endpoints → Model roles →
  Decision gate → "Turn plan (dynamic roster)" → act. Rollback: set it back to
  shadow, or `QUICK_LANE_DISABLED=1` (the plan keeps recording).

## 7. Progress log (live)

**2026-10-03 — shipped and verified in prod**
- PR #1228 (the §2 fixes) — live 19:49Z. Verified: "what is the source of the
  Nile?" now routes to Level 1 (`simple_lookup`), not the 20-minute council.
- PR #1229 (phase 1) — live 20:23Z. `GET /admin/model-roles/auto-pools` answers
  403 to a non-admin (the route exists, the admin gate holds).
- PR #1230 (phase 2, shadow) — live 20:43Z. A live weather question recorded
  `depth.turnPlan` = lane **quick** at p 1.00 in both option orders,
  needs_live_web 0.98, contested 0.02, breadth 1, roster lead
  `cql-litellm:api-optimize-alibaba-qwen3.8-flash` (the Helper via the Quick
  answers seat) — but "quick no (stakes 0.52)": the first-cut 0.5 stakes ceiling
  blocked the textbook case. Today's Level 1 path answered it in **55–57 s** to
  the first token.

**Offline replays (87 human questions, last 30 days, plain chats)**
- Jev answered 87 / 87, p50 140–143 ms, p95 188–189 ms; the two option orders
  disagreed on 1 / 87 (position bias is small for this question set).
- Lane mix (Jev): quick 19, standard 60, checked 2, research 6.
- Replay #1 — judge = the Utility seat (qwen3.8-flash, no reasoning): 72 %
  agreement; Jev-quick ⇒ judge-quick 15 / 19.
- Replay #2 — judge = the Double Checker seat (DeepSeek V4.1 Flash via the
  gateway, reasoning on, p50 3.5 s): 81 % agreement on the 83 it labelled;
  Jev-quick ⇒ judge quick 12, standard 1, checked 3, research 3.
- Guard grid (would-Quick turns / judge-quick precision [Wilson 95 %] / judged
  checked-or-research): p ≥ 0.7 · stakes < 0.6 · contested < 0.5 → 12 / 0.75
  [0.47, 0.91] / 3 unsafe; **p ≥ 0.8 · stakes < 0.6 · contested < 0.5 → 8 /
  1.00 [0.68, 1.00] / 0 unsafe**; p ≥ 0.8 · stakes < 0.7 → 9 / 0.89 / 1 unsafe.
  The 8 would-Quick turns had paid a median ~110 s to the first token.
- Chosen guards (`platform/quick-lane-guards.ts`): **p(quick) ≥ 0.8, stakes <
  0.6, contested < 0.5**, ≤ 600 chars, no attachments, no code intent, Level 1/2
  preset, not a follow-up in a Checked / Research session, human plain-chat
  turn, calibrated answer. Overrides: `DECISION_GATE_THRESHOLD_TURN_PLAN_QUICK`,
  `TURN_PLAN_QUICK_STAKES_CEILING`, `TURN_PLAN_QUICK_CONTESTED_CEILING`.

**Hardening (phase 2b)**
- Act canary: users listed in `['instance','turn-plan']/config`
  `actCanaryUserIds` take the Quick lane while the purpose is shadow
  (`scripts/framework-audit/set-turn-plan-canary.js`, dry run by default). The
  prod test account is the canary.
- A Quick turn whose quick model answers nothing is finished on the Digby seat
  (the normal lead) before any other fallback; `seat_fallback` rows carry
  `lane: 'quick'`.
- `ux_ttft` rows carry `lane` + `leadModel` on a Quick turn.
- UI: a Quick-lane answer shows a quiet "Quick answer" pill; the Dig-deeper chip beside it re-runs the question at Level 2 with the checker.
- Ops: `scripts/framework-audit/turn-plan-readout.js` (live shadow / canary
  readout) and `replay-turn-plan.js` v2 (reasoning judge + guard grid over the
  production rule) — both read-only, aggregates only.

**Live canary + randomized query suite (2026-10-04)**
- Canary: the prod test account was put on `actCanaryUserIds` at 00:31:48Z
  (ec2-ops one-shot TPC1003, run 37164682029).
- `scripts/e2e/query-suite.py` (new — randomized live questions through the
  prod stream: routing, the turn-plan lane / act, tool calls, latency, a
  transcript audit). Seed 303: 22 cases / 26 turns → 20 PASS, 1 WARN, 1 FAIL
  (a suite gap: a "create ideas.md" send runs on the coding harness, whose
  stream frames the suite did not read yet — fixed in the suite).
- **Quick lane acted on 6 turns, 0 wrong-lane acts.** No-tool lookups were
  fast — units 7.8 s, time 19.1 s to the first token (qwen3.8-flash) — but web
  lookups chained 3–5 tools under the full chat doctrine: weather 44.6 s /
  93.2 s, sports 68.8 s, news 161.8 s. The speed was spent in the tool loop, so
  a Quick turn now carries a short lane brief (one search, answer from it, one
  page only when needed; no web_pipe / delegate / browser_task / memory
  search; `chat-agent/quick-lane-note.ts`, `QUICK_LANE_BRIEF_DISABLED=1`).
- Guards held: quick-but-blocked turns were p(quick) 0.72 / 0.65 / 0.49 (under
  0.8) and a "convert 10,000 USD" at stakes 0.81; the follow-up in a contested
  session stayed off Quick; a code request ran standard (L2, 12.5 s).
- Dig deeper on a Quick answer ran the verify rung (L2 + checker) and posted a
  "Deeper findings" row both times (176 s / 285 s).
- **Research routing gap (phase 3 input):** the Quebec question — the plan's
  own example of a deep-research ask — came out lane *standard* by a hair
  (standard 0.365 vs research 0.355) with contested 0.97 and breadth 4/4; the
  Auto router sent it to L2. A trait rule (contested ≥ 0.9 ∧ breadth ≥ 3 ⇒ at
  least checked; research within 0.05 of the top lane ∧ breadth 4 ⇒ research)
  belongs in the research-routing phase, not in today's quick-only act.
- Tools batch (seed 77, 12 cases): 12 PASS — every chat tool family ran as
  asked; the Quick lane took 3 of them (scrape 21.4 s, news 80.7 s, an explicit
  "use the browser" 120.4 s). The lane brief yields to an explicit tool ask.
- Two prod bugs found and fixed (see AGENTS.md 2026-10-04): the orphan
  sweeper answering a > 5-min question TWICE (Rule B snapshot race), and a
  false action-verifier correction on an honest "my browser task timed out".

**Phase 3 input — the shadow research rule (2026-10-04).** `turn-plan.ts ruleAdjustedLane` records a
trait-adjusted lane beside Jev's argmax (`ruleLane`: a broad near-tie with research ⇒ research; contested + broad
⇒ at least checked). It routes nothing; the nightly live-chat audit's judge scores rule vs argmax every night —
when the rule beats the argmax on judged turns, research routing (the controller quota reserve + the council) can
act on it.

**Status 2026-10-04 04:00Z: `turn_plan` is in ACT fleet-wide** (owner; TPA1004) — the Quick lane serves every
eligible human turn; the canary list is cleared.

**How to read before the flip** — `prodq.sh turn-plan-readout.js 7`: acted
Quick answers vs Dig-deeper taps on them (the miss rate), Quick seat fallbacks,
and Quick first-token p50 vs today's Level 1.

**2026-10-04 — Per-turn MODEL PICK (owner: "shouldn't the decision model decide any model it wants for the specific
task")** — the Phase 3 / Phase 5 step for the lead model: instead of the seat (or the pool's first model), every
standard / checked turn scores every open, servable chat model on measured quality vs time-to-first-word for that lane
and stakes (`platform/model-pick.ts`, evidence `platform/model-evidence.ts`), switching only when clearly better and
never on unmeasured models (offline benchmark only — no live exploration). Shadow by default (records the pick on
every answer row); the canary acts; `set-model-pick-mode.js --apply act` flips it. Explicit per-chat model pins win
over every automatic swap. Next: run the benchmark on the shortlist, read shadow picks vs the seat, then flip.

**2026-10-20 — Depth by lane for every user + the task-aware pick (owner: "yes do all of this to make digby more
sota").** Readout LDR1020B (7 d): 96 human turns, 0 missing turn plans; 129 user + 5 guest turns ran a Double Checker
the lane would drop; lane flags were still shadow (owner canary only). Code shipped first: guests / quota-refused sends
are never lane-routed to Level 3 (`researchDenyReason`), the checker drop keeps the checker on a follow-up in a
checked / research session, and a pure live lookup takes Quick up to stakes < 0.75. Then the store flips:
laneChecker → act (LDA1020 waiter, once the new code is active), laneResearch → act after; laneFailOpen stays shadow
(0 plan failures in 7 d — its only effect would be dropping checkers during a classifier outage). The per-turn model pick gains the job type:
the `task_kind` decision purpose + kind-keyed bench buckets (`modelPickKind` shadow until a kind bench lands, then act).
Canonical: the 2026-10-20 SOTA wave bullet in AGENTS.md.
