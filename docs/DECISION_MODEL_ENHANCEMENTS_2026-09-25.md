# Decision-model enhancements: is Digby using Jev the best way, and where the real speed-ups are

**Evaluation, 2026-09-25.** Written for the owner. Follow-up to
[`JEV_DECISION_MODELS_DIGBY_EVAL_2026-09-24.md`](JEV_DECISION_MODELS_DIGBY_EVAL_2026-09-24.md) (the eval doc),
one day after the decision seat (#19) went live on TypeSafe Jev (key in prod since 2026-09-25 16:40Z). Inputs: the
paper *JEV-as-a-Judge: Accept When Confident, Escalate When Unsure* (arXiv 2609.26550v1, Li/Miao/Krishnan/Padman,
CMU, 21 Sep 2026 — "the paper" below, cited by section), the TypeSafe docs the paper cites, the runtime
(`backend/src/modules/crossmodel/platform/decision-gate.ts` and its seven consumers), and read-only prod SQL over
`loop_metrics kind='decision_gate'` (snapshot 2026-09-25 21:06Z unless a query time is stated). Four research passes
and two critique passes were synthesized; every number carries its source; "not measured" means nobody could get it.
File references are `backend/src/modules/crossmodel/...` unless stated.

> **Status (2026-09-26 02:05Z):** every E-item and N-item below carries its own STATUS line; §6.1 records which purposes
> are ACTUALLY in act (five: `sweep_triage`, `imessage_send`, `wake_triage`, `auto_route`, `drain_triage`) and why each of
> the remaining twelve is not. The "no purpose moved to act" statements in the item STATUS lines describe the 2026-09-25
> merge state and are superseded by §6.1.

## 1. Executive summary

**Is the implementation the best fit for this project? On shape, yes.** The gate is a cascade, not a swap
(`decision-gate.ts:18-21`); every consumer keeps its pre-gate path and fails open (`hooks.service.ts:1866-1868`,
`self-audit-gate.ts:75-77`, `imessage/nlp.ts:139-141`, `browser-agent/router.ts:339-341`, `langgraph/memory.graph.ts:1729-1732`,
`coding/schedule.service.ts:3419-3421`); the request is byte-compatible with the vendor's `/v1/systemone` contract
(`decision-gate.ts:66-74`, `:387-402`); states are code-selected named-field objects under a 24k-char cap (`:123`);
modes are shadow-first and store-backed fleet-wide (`decision-gate-modes.ts:1-40`); deferred outcomes are labelled from
what the run actually did (the WI-C stash, `decision-gate.ts:784-800`). This is the paper's Fig. 4 shape (decision =
candidate verdict, confidence = routing gate, reasoning model = fallback) and the vendor's "keep control flow and side
effects in code" guidance. Jev itself is fast and effectively free in prod: p50 268 ms / p90 321 ms on wake_triage
(SQL, 141 rows), and 209 decisions consumed 212,420 input tokens on 09-25 ≈ 1,016 tokens/decision ≈ **$0.009/day** at
$0.042/M (paper §5 fee table; SQL volume-per-day). Zero failed legs and zero fall-throughs in 932 decisions over 7 days.

**The speed-up story, honestly: shadow sheds nothing, and no purpose can be flipped on evidence today.** All seven
purposes record only. The reasons are not the model; they are the ruler and two question designs:

1. The only calibration tool never evaluates the backend that answers ~95–100% of decisions:
   `pairDecisionRows()` skips every Jev row because they carry no `meta.logits` (`decision-gate-fit.ts:196-220`).
   Agreement is computed at a 0.5 cutoff (`decision-gate.ts:758`) while every act cutoff is 0.15 / 0.2 / 0.7 / 0.85.
   The paper's decisive metric (error-detection AUROC of 1−q and the risk–coverage curve per workload, §6–§7) and the
   eval doc's own rule ("coverage at ≤5% error ≥ ~60% or the purpose stays on the reasoning seat", eval doc §6c) are
   implemented nowhere.
2. **wake_triage** (the flagship, 482 decisions/24 h) shows the paper's "confidently misled" regime on its first
   labels: of 16 Jev decisions inside the act band (noul ≤ 0.15), 4 were wakes whose run then took a mutating action
   (SQL act-band query; 25% false-park). The paper's rule for that pattern is that no threshold helps (§7 "Where the
   signal weakens"). And a park is a 30-minute deferral that then delivers unconditionally
   (`hooks.service.ts:1822`, `:357-361`), so even a correct act mode sheds delay, not work, unless the parked batch
   coalesces into a later wake.
3. **self_audit** (253/24 h, the other big purpose) is mis-posed: receipts reach the gate as `{tool, ok, ids}` only
   (`self-audit-gate.ts:32`), Jev answers "unevidenced" on 41/46 rows, 0/50 decisions ever reach the skip band, and
   the label ("a completed step got reopened", `self-audit-gate.ts:99-103`) disagreed with Jev on 9/9 labelled rows.
   Act mode would skip nothing. This is the class the paper marks "Escalate" (derivation checking, Table 2).
4. **memory_extract**'s label is constant (`actual:true` whenever the extractor ran, `memory.graph.ts:1749`), so its
   14 labelled rows measure nothing; **imessage_send** is 45/45 agreed but every example is a non-send, so recall on
   the only class that matters is unmeasured; **delta_material** has 0 labels; **browser_driver** 3 rows in 7 days;
   **auto_route** 1 row because nothing sends `mode=auto` yet.
5. The DeepSeek fallback readout is structurally 0/1, not miscalibrated: option letters absent from the top-20
   logprobs get −∞ (`decision-gate.ts:461-482`, `decision-gate-math.ts:21-24`), so 709/709 readout nouls are exactly
   0 or 1 and no temperature can move them. Under act, `decide()` returns the readout's answer with the same mode after
   a Jev failure (warn only, `:719`), and every consumer applies one threshold whichever leg answered.

**Where the real wins are** (all ceilings; sources in §3):

| Win | Size | Status |
|---|---|---|
| Supervisor wake turns removed by triage | ceiling $47–59/day, 276–1,660 model-minutes/day (291 hook-origin supervisor turns/24 h, 60.5% harness no-op, $0.268/turn) | Not before the state redesign (§4 E7) and ≥200 labels; today it is delay, not removal |
| Self-audit rounds skipped | ceiling ~$50/day (range $38–66), 480–860 min/day (254 rounds/day × ~$0.20, ~2–3.5 turns) | Zero today; needs re-pose or retire (§4 E8) |
| Sweep pre-triage (new purpose) | ~$12/day and 2.6–5 h/day of supervisor busy time at 50% coverage; $23/day and 5–10 h/day full (143–158 sweep turns/day, 53–58% no-op) | The first new purpose worth adding (§5 N2) |
| Machine-wake reasoning effort max → high | order $30–60/day and up to ~50 h/day of aggregate thinking (631 supervisor machine turns/day) | Conflicts with the owner's "machine wakes keep max" (`chat-agent/human-turn-effort.ts:6-9`) — owner decision (§8) |
| iMessage send-intent latency | ~5 min/day of user-facing latency (37 turns × ~8 s), ~$0.04/day | Closest flip; needs ≥30 labelled positive sends first |

Against $890/day of machine spend (7-day `run_spend`), the gate's USD upside is tens of dollars a day; its real value is
supervisor throughput (hours/day) and user-facing seconds. The week's work is the ruler, three label fixes, one safety
guard and one state redesign — not more purposes.

## 2. What the paper prescribes vs what we do

The paper is an empirical judge evaluation of hosted Jev 1.13.0 against 16 generative and reward-model judges; it does
not describe Jev's architecture or training ("JEV's implementation is proprietary", §1; "We evaluate one proprietary JEV
version", Limitations) and never mentions JevK5, NeoHorse or Kev. The pointer-head mechanics in the eval doc §1 are
labelled there as inferred and are confirmed by neither the paper nor the vendor. What the paper and the vendor docs it
cites DO prescribe:

| Practice | Paper / vendor | Digby today | Gap | Fix |
|---|---|---|---|---|
| Typed primitives, calibrated probabilities, input-only billing | §4: Choice/Noul/Score; native confidence ≈ max label probability (Spearman 0.971/0.999/0.948); "charged $0.042 per million input tokens and nothing for output" | `DecisionQuestion`/`DecisionAnswer` mirror the three primitives (`decision-gate.ts:66-74`); body byte-compatible (`:387-402`) | none | — |
| State as a named-field object holding only what the question needs | vendor `/concepts/state`; jaggedness #5 "accuracy falls as the state grows with content unrelated to the decision" | Objects at all seven sites; 24k-char cap (`:123`); wake_triage state is `{target, event_type, events, source_chat, summary≤6000}` (`hooks.service.ts:1826-1832`) — the summary is lane-authored prose | wake_triage's state lacks the code-computable facts that determine action (4/16 act-band false parks) | E7: code-computed fields first (event kinds, any row is a question, lane status flags, last outcome), prose last and capped |
| Ask narrow, atomic questions; never hide several judgments in one | vendor how-to-build ("probably the most important concept"); jaggedness "Hiding several judgments inside one question" | self_audit's one noul asks whether the summary claims a push/merge/deploy/fix/verification/message/file change unsupported by receipts OR marks a step completed unsupported (`self-audit-gate.ts:52-65`) | compound question over 16 receipts and up to 40 steps (jaggedness #2 counting, #4 indirection) | E8: per-step / per-claim nouls built in code (SDE-cascade cookbook) |
| Criteria on every Noul when the boundary is subtle; an escape option on every Choice | vendor `/primitives/noul`; `/api` Choice ("add an other / none of the above option") | wake_triage, self_audit, delta_material, imessage_send carry criteria; memory_extract's three nouls carry none (`memory.graph.ts:1713`); browser_driver and auto_route have no escape option (`router.ts:315-319`, `auto-router-gate.ts:37-41`) | 3 nouls without criteria, 2 choices without an escape | E9 |
| Speculative fan-out: many independent questions in one request, "adding more questions usually has little effect on response time" | vendor `/patterns/fan-out`; parallel-questions cookbook (13 batched = 12.2× cheaper, 10× faster) | memory_extract batches up to 3 nouls; the other six purposes send ONE question | free instrumentation unused; the eval doc §0 rec #1 4-way wake choice was never built | E7, E8, E11 (imessage extras) |
| Confidence is an escalation signal, validated per workload; thresholds chosen on a selection set, re-checked on held-out | §7 frozen policy (τ chosen "to maximize coverage while keeping selection-set accuracy within two points of the fallback"); §8 checklist items 2, 4, 5; τ=0.9 gave 53.7% acceptance at 92.5% vs 93.1%; τ=0.7 broke tolerance; τ=0.5 collapsed (Table 11) | Static env defaults: 0.85 skip-work, 0.7 routing, 0.8 memory (`decision-gate.ts:173-179` clamp; call sites) — no derivation | no selection/held-out split, no per-workload validation | E1 (threshold search inside the report) |
| Temperature per workload, validated | §6: fitted T = 0.65 / 2.15 / 4.45 across tasks; "No single temperature fits" | `DECISION_GATE_TEMP_<PURPOSE>` applies to the readout only (`:189-194`); Jev used raw; the readout cannot be fitted because absent letters are −∞ (`:461-482`) | readout unfittable; Jev never checked | E2 (readout censoring) — Jev post-hoc T dropped (§4) |
| Go/no-go metric = error-detection AUROC and risk–coverage per workload | §6 Table 7 (AUROC 0.869/0.745/0.863), §7 (accuracy rises monotonically with q, 47.7% at q<0.6 → 99.1% at q=1; RM-Bench hard AUROC 0.770) | fit script reports accuracy/NLL/Brier/ECE (`decision-gate-fit.ts:34-48`), skips systemone rows (`:196-220`); agreement at 0.5 (`decision-gate.ts:758`) | the numbers a flip needs do not exist | E1 |
| Count invalid outputs as errors; verify Σp and verdict=argmax | §4 validity (sum tolerance 0.025), §8 item 3 | `normalizeProbabilities` renormalizes any non-negative weights silently (`:337-353`) | a broken server can pass as calibrated | E10 (contractViolation stamp, lenient flag for open-weights) |
| Judge pairs in both orders and average | §6: reversal flipped 3.25% (RB) / 11.14% (JB); Eq. 1; §8 item 1 | fixed option order at both Choice sites; nothing measures flips | unmeasurable at 3 + 1 rows/7 d | E16 (deferred until a Choice purpose carries traffic) |
| Pin the model version once thresholds are tuned | vendor `/models`: "pin that version's ID instead of the alias"; response `model` reports the versioned id | `TYPESAFE_DEFAULT_MODEL='jev-latest'` (`:115`); `recordDecisionRow` stores no model id (`:631-652`) | a vendor release silently invalidates fitted numbers | E4 |
| Retry 429/529 with exponential backoff, honour Retry-After | vendor `/api`; SDK RetryPolicy max_retries 2, 0.5→5 s, jitter 0.25 | one fixed 400 ms retry (`:406-409`) | matters only at act-mode volume (0 errors in 7 d) | E10 |
| State is data, not hostile by default; content can move the answer | jaggedness #6; paper ethics: "Confident errors argue against using any automated judge as the sole arbiter" | readout prompt declares state as data (`:434-437`); AGENTS.md:1571 NEVER rule keeps consequential verdicts on reasoning seats; three purposes put user/lane text in state by necessity | risk accepted but unmeasured | E11 canary; E7 sanitisation by construction |
| Operating envelope: use where evidence is in state / ordinary preference; escalate for multi-step derivation and style-adversarial pairs; reference-free prose "not supported" | Table 2 (JudgeBench −14.6, RM-Bench −19.8; reference-free 52.5 vs 55.0, AUROC 0.518) | wake_triage, delta_material, imessage_send, browser_driver, auto_route = evidence-in-state classification (in envelope); self_audit = derivation/indirection; memory_extract = reference-free "worth remembering" | two purposes sit outside the envelope, and the candidate list drifts further (reconcile-or-skip, goal-continue) | E8 re-pose or retire; E15 doctrine table |
| One prefill, many questions, ~150 ms | §5: median outcome latency 0.152 s, $0.044 per 1,000 judgments; vendor "most queries complete in about 100 ms" | Jev p50 265–295 / p90 292–365 ms from ca-central-1 (SQL); the readout issues one prefill PER question (`:572-592`), p50 700–830 ms | fan-out is free on Jev only | note in E2; fan-out designs must not assume the readout is free |
| The judge is not the agent | vendor coding-agents page: "There is no model: jev-latest setting that turns your coding agent into a Jev-powered agent" | matches: `decide()` feeds an `if` at every site | none | — |

Bottom line for §2: the contract and the cascade are right; the deviations are (a) no measurement on the backend we run,
(b) two questions posed in the shape the vendor says the model handles worst, (c) no fan-out, (d) unpinned version,
(e) a fallback leg that cannot be calibrated and is not fenced off from act mode.

## 3. Per-purpose readiness and savings (telemetry)

Snapshot 2026-09-25 21:06Z (7-day window; `decisions_24h` = last 24 h; labels only exist since the 20:00Z deploy for
wake_triage/self_audit; `act band` = confidence ≥ 0.85, i.e. the region an act flip would act on; readout rows before
16:40Z were the pre-Jev era plus the other blue/green colour until 18:18Z).

| Purpose | Decisions 7 d (24 h) | Backend split | Jev p50/p90 ms | Labelled | Agreed at 0.5 | Act band: n / correct | Positives seen | What act would shed | Est. saving/day (ceiling) | Readiness |
|---|---|---|---|---|---|---|---|---|---|---|
| wake_triage | 571 (482) | readout 430 / Jev 141 | 268 / 321 | 20 (Jev) | 15 / 5 | 16 / 12 (4 needed a turn) | 5 | a 30-min park of a non-alarm batch; delivers unconditionally after (`hooks.service.ts:1848-1862`) | $47–59 and 276–1,660 model-min if parks coalesce; else delay only | NOT READY: n=20 vs ≥200; 25% act-band false parks; state redesign first |
| self_audit | 295 (253) | readout 245 / Jev 50 | 267 / 294 | 9 (Jev) | 0 / 9 | 4 / 0 (all "unevidenced", wrong); skip band 0/50 | 0 | the +20-step audit round (`coding/agent.ts:4429-4474`) | $50 (range $38–66), 480–860 min — $0 as posed | NOT READY: question and label misaligned; nothing to shed |
| imessage_send | 45 (38) | readout 18 / Jev 27 | 295 / 365 | 45 | 45 / 0 | 45 / 45 | **0** | the ~8 s utility send-intent call (`nlp.ts:102`) | ~5 min/day user-facing latency; ~$0.04 | CLOSEST, but recall on real sends unmeasured; needs ≥30 labelled positives |
| memory_extract | 10 decisions = 14 question rows (9) | readout 6 / Jev 4 | 272 / 295 | 14 | 9 / 5 | readout 8/7; Jev 0 | 14 (constant) | up to 3 deepseek-flash extractor calls | <$0.01, <1 min; ~500 ungated coding/project extractor calls/day are where the volume is | NOT MEASURABLE: label vacuous (`memory.graph.ts:1749`) |
| delta_material | 9 (7) | readout 8 / Jev 1 | 275 (n=1) | 0 | — | — | — | the scheduled firing itself — real removal (`schedule.service.ts:3404-3417`) | ≤ ~$0.3–1.5, ≤ ~8–35 min | NOT READY: 0 labels; ~1 decision/day |
| browser_driver | 3 (0) | readout 3 | readout 834 / 882 | 3 | 1 / 2 | 3 / 1 | — | the 30 s GLM driver call (`router.ts:343-363`) | ~$0.002, ~0.2 min | NOT READY: no volume; readout wrong on 2/3 at confidence 1.0 |
| auto_route | 1 (1) | Jev 1 | 450 (n=1) | 1 | 0 / 1 | 0 | — | nothing (the regex heuristic is free); the value is placement quality | $0 | NO TRAFFIC: nothing sends `mode=auto`; owner-mandated next program (patience plan) |

Sources: the snapshot query (`dm-synth/q-snapshot.txt`, `q-actband.txt`); supervisor economics from 24 h `run_spend`
(machine chat-profile n=591, avg $0.268, p50 $0.22) and `crossmodel_messages` origin classification (hook-origin
supervisor turns 291/24 h, 60.5% no-op; 7 d 55%); wake duration = `wake_delivered` → `run_spend` gap (hook-stamped p50
75 s, n=18; machine p50 451 s, includes queue wait); self-audit round = audit start → run finalize p50 114 s / p90 335 s
≈ 2–3.5 turns at $0.074/turn (247 audited coding runs, avg $2.61, 35.4 turns). Not in the repo: TypeSafe's per-call
price (the $0.009/day is the paper's fee applied to measured tokens). Not measured: how often a triage-parked batch is
absorbed by a later wake vs delivered on its own — the number that turns the wake_triage ceiling into a real figure.

Two reliability notes on the labels themselves: (1) the readout's 709 noul values are all exactly 0 or 1, so "agreed"
on readout rows is a coin with no confidence information; (2) 362 of 482 wake_triage decisions in 24 h share
`(sessionId, stateChars)` and 28/49 outcome rows since 20:00Z closed "not started: busy" and are re-asked next sweep
with identical state — every n above is inflated by correlated duplicates until E3 lands.

## 4. Enhancements to the existing gate (ranked)

Ranking = (unlocks a flip or removes a way act mode could act on garbage) × effort. Critique scores from the two lenses
are in brackets. Nothing below changes what any consumer does in shadow; nothing adds a blocking gate on a lane's own
work (the 2026-09-11 rule).

| # | Change | Files | Expected gain | Risk | Kill switch | How to verify |
|---|---|---|---|---|---|---|
| **E1** [9/9] **Flip-readiness report**: pair Jev rows by `meta.id` using `meta.answers` probabilities (not only `meta.logits`); per (backend, purpose) print n, accuracy, Brier, ECE, **AUROC of 1−confidence vs disagreement**, **coverage at ≤5% error**, **precision inside the act band at the purpose's real cutoff**; threshold search with the paper's frozen-policy rule on a 60/40 time split clustered by `sessionId`; dedupe by `stateHash`, partition by `questionsHash`; store per-option probabilities for Choice (`compactAnswers` drops them, `decision-gate.ts:607-615`); record `thresholdUsed` and `agreedAtCutoff` on outcome rows (`:748-782`); mark a purpose READY/NOT READY | `platform/decision-gate-fit.ts`, `backend/scripts/decision-gate-fit-temperature.ts`, `platform/decision-gate.ts` | The go/no-go numbers exist for the first time; today no purpose can be flipped on evidence | none (read-only tooling + two meta fields) | `DECISION_GATE_READINESS_STAMP_DISABLED=1` (the script prints but never stamps; readers fail closed) | `npm run decision-gate:fit` prints a row for every (backend, purpose) with ≥1 label, including TypeSafe Jev; wake_triage shows act-band precision 12/16 on the current rows. **Status 2026-09-25: SHIPPED** — `decision-gate-fit.ts` (`ACT_POLICIES`, `pairReadinessRows`, `auroc`, `coverageAtError`, `actBandStats`, `searchThreshold`, `buildReadinessReport`, `READINESS_BARS`), `decision-gate-readiness.ts` (stamp store `instance:decision-gate/readiness` `{<purpose>:{ready,at,metrics,…}}`, fail-closed `isPurposeStampedReady`), `--stamp` on the script, outcome rows carry `thresholdUsed` / `inActBand` / `agreedAtCutoff` + choice `probabilities`, `GET /admin/model-roles/decision-readiness`, admin readout under the Decision gate seat. The threshold search runs the frozen-policy rule (60/40 by time, sessions whole) as a printed suggestion only. No purpose moved to act. |
| **E2** [9/9] **Act only on a calibrated backend; per-leg budgets**: `decide()` returns `calibrated:boolean` (systemone, or a readout with a fitted `DECISION_GATE_TEMP_<PURPOSE>`); in act mode an uncalibrated answer is returned with `mode:'shadow'` so no consumer acts; each leg gets `min(remaining, DECISION_LEG_TIMEOUT_MS≈1000)` instead of the whole deadline (`:681`, `:710`, `:398-401`); trip a leg after N consecutive timeouts. Also censor absent readout letters to the 20th-ranked logprob (or min−1 nat) instead of −∞ (`:461-482`) and run the two-order readout for noul/≤3-option choice (paper Eq. 1) so the fallback becomes fittable | `platform/decision-gate.ts`, `decision-gate-math.ts`, `decision-gate-fit.ts:129-130`, `decision-gate.test.ts` | Removes the one path by which act mode acts on a 0/1 readout after a Jev failure; fallback still reachable inside the 1.5–2 s request-path budgets (Jev p90 ≤365 ms) | low — fallback leg only; shadow today | `DECISION_GATE_LEG_TIMEOUT_MS` unset = today; `DECISION_GATE_LENIENT_PARSE=1` | unit test: Jev leg throws → readout answers with `mode:'shadow'` in act; prod: readout rows stop reading exactly 0/1 |
| **E3** [6/9] **Memoise identical asks; stamp `stateHash`/`questionsHash`**: in-process LRU keyed `sha256(purpose|questions|state)`, TTL ~10 min, returns the stored answer (row recorded with `cached:true`) | `platform/decision-gate.ts` (`decide`, `recordDecisionRow`), `platform/hooks.service.ts:1822-1873` | ~50% fewer wake_triage calls (362/482 repeats); duplicate-free calibration set; instruction drift visible (paper App. G: rewording shifts distributions by ~0.055) | low — cache only ok answers; same rows ⇒ same state, so act-safe by construction | `DECISION_GATE_MEMO_DISABLED=1` | decision count/24 h drops; `cached:true` share ≈ busy re-ask share. **Status 2026-09-25 (E3b fix):** LIVE DEFECT at 23:20Z — 0 cached rows over 37 min / 24 asks: the E7 wake_triage state carried whole-minute event ages (`oldest_event_age_min` / `newest_event_age_min`) and the growing batch count, so the busy re-asks of the SAME batch (chat c6941c11 at 23:18:12 and 23:19:01) hashed differently every minute and the memo never hit. Fixed by separating the MEMO key from the exact-state hash: `decisionHashes(purpose, questions, state, memoState?)` keys the memo on a memo-stable projection — the consumer's explicit `opts.memoState` (wake_triage's E7 builder now emits one: ages bucketed 0-5 / 5-15 / 15-60 / 60+ min, the batch identified by its sorted event IDS instead of its count, lane `ended_min_ago` bucketed, the digest prose kept — it carries absolute stamps only) or, for every other purpose, the generic fallback `memoProjection()` (bucket numeric `*_min` / `*_minutes` / `*_ago` / `age` fields, drop `*_at` / `*At` / `timestamp` / `*_ts` keys). Rows carry BOTH `meta.stateHash` (exact state, the ruler's dedupe key — unchanged) and `meta.memoHash` (the memo key); a hit stamps its own exact stateHash next to the shared memoHash + `cachedFrom`. A batch with a NEW event id is a different memoState (never served from cache); a row without an id or an alarm-class row (the sweeper's `isAlarmRow` predicate) makes the batch un-memoable (`memo:false` — neither read nor written). Only ok answers are memoised, as before. Kill switch `DECISION_GATE_MEMO_NORMALISE_DISABLED=1` (memo keyed on the exact state again). Live verify: `cached:true` wake_triage decision rows within 30 min of deploy; the hit share should approach the busy re-ask share (~50%). |
| **E4** [8/8] **Pin the Jev version; log the answering model id**: `TYPESAFE_MODEL=jev-1.13.0` in prod; `meta.model = resp.data.model` on every decision row; throttled warn when it changes | `platform/decision-gate.ts:115`, `:402`, `:631-652`; `.env.example`; `docs/REMOTE_OPS.md` | Fitted thresholds cannot be silently invalidated by a vendor release | none | n/a | rows carry `meta.model`; a probe with `jev-latest` vs the pin shows the same id today |
| **E5** [8/7] **Honest labels + cost stamps**: memory_extract `actual` = extractor persisted ≥1 change (`memory_extraction meta.outcome changed/noop` already exists); self_audit `actual` = OR(step reopened, evidence-guard strike on the final, verifier reject-back) with components in `meta.note`; imessage_send positive class from the send modal's confirm/decline; delta_material state gains the eval doc's "last run one-line outcome" field (dropped at `schedule.service.ts:3388`); stamp the decision `meta.id` onto the run's `run_spend` / `self_audit_run` row so shed cost is exact | `langgraph/memory.graph.ts:1743-1751`, `coding/self-audit-gate.ts:96-103`, `imessage/nlp.ts:187-190`, `coding/schedule.service.ts:3388`, `platform/loop-metrics.service.ts`, `coding/agent.ts` | Three purposes become measurable; the $0.15–0.26 and 75–451 s ranges in §3 become exact | low — telemetry only | `DECISION_GATE_OUTCOME_LABELS_DISABLED=1` (exists) + per-item: `MEMORY_EXTRACT_OUTCOME_LABELS_DISABLED`, `SELF_AUDIT_COMPOSITE_LABEL_DISABLED`, `IMESSAGE_SEND_MODAL_LABEL_DISABLED`, `DELTA_MATERIAL_LAST_RUN_FIELD_DISABLED`, `DECISION_GATE_COST_STAMP_DISABLED` | memory_extract `actual_true` share < 100%; imessage_send `actual_true` > 0; run_spend rows carry `decisionId`. **Status 2026-09-25: SHIPPED (shadow-safe, telemetry only).** memory_extract: each extractor node returns its measured outcome and the rows are written after the extractors settle (`memoryExtractActual`: changed ⇒ true, noop ⇒ false, failure ⇒ null; content diff ignores lastUpdated/messageCount). self_audit: `labelSelfAuditOutcome` = OR(reopened, guard-struck parts appended after the grant, reject-backs after the grant) with components in `meta.note`; the `self_audit_run` row carries `selfAuditDecisionId` + `costUsdBefore`/`turnsBefore` and the run's `run_spend` carries `selfAuditDecisionId` (act-mode skips carry no stash, so only shadow rows join today). imessage_send: a SURFACING draft defers its label — the decision parks in Redis (`imessage/send-draft-outcome.ts`, 6 h TTL) and the confirm card's Send (`POST /imessage/send` body.decisionId ⇒ actual:true) / Cancel (`POST /imessage/draft-outcome` ⇒ actual:false) writes the row; a non-surfacing verdict still closes at classification time. Found while wiring: the card was DEAD since the 2026-07-23 cutover (the plain bridge dropped `imessage-draft`; page.tsx had the dialog but no feeder) — re-wired via `PlainSessionProps.onImessageDraft`. delta_material: state gains `last_run_outcome` (the lane's previous labelled delta_material outcome row + schedule lastStatus/lastFiredAt — `formatDeltaLastRunOutcome`). Cost stamps: `MetricStamp.decisionId` / `selfAuditDecisionId` merge under every stamped row (run-executor threads `claimed.input.decision.id`; chat-agent stamps `args.decision.id`). |
| **E6** [7/8] **browser_driver shadow runs concurrently**: `router.ts:320` awaits `decide()` in every mode before the 30 s GLM call — copy the `nlp.ts:108-138` pattern | `browser-agent/router.ts:311-341` | −0.3…0.9 s on every browser task selection (readout p50 834 ms) | none | `BROWSER_DRIVER_GATE_CONCURRENT_DISABLED=1` | shadow rows still recorded; GLM call starts at t≈0. **Status 2026-09-25: SHIPPED.** Shadow starts `decide()` and the GLM call together and records the outcome after both settle (`settleGate`); act still awaits the gate first (a confident pick skips GLM); pinned by `router.decision-gate.test.ts` (GLM called while the gate is still pending). |
| **E7** [7/8] **wake_triage state and question redesign** (stay in shadow): state adds code-computed fields (event kinds present, whether any row is a question/request, lane status flags, source lane's last outcome, alarm-class present) before the capped prose summary; one request carries `needs_turn_now` (noul, unchanged for comparability) + `disposition` choice {ack, coalesce, act_now, escalate_owner} + `addressed_to_supervisor` noul + `contains_failure_or_block` noul + `urgency` score; per-option thresholds `DECISION_GATE_THRESHOLD_<PURPOSE>_<OPTION>`. Keep the park bounded (no chained re-triage on re-delivery — the WI-R "nothing is lost" guarantee). Alternative act semantics for the owner (§8): route a confidently no-action batch into the supervisor's board digest instead of any wake | `platform/hooks.service.ts:1805-1873`, `platform/decision-outcome-labels.ts:74-89`, `platform/decision-gate.ts:173-179` | Targets the 4/16 false-park class; zero added latency on Jev; measures what a 4-way choice would have parked | low in shadow; act unchanged | `DECISION_GATE_MODE_WAKE_TRIAGE` (exists) | after ≥200 labelled rows: act-band precision ≥0.9, AUROC ≥0.8, coverage at ≤5% error ≥60% on the E1 report |
| **E8** [7/6] **self_audit re-pose or retire**: receipts carry args head + result head (≤200 chars, from `run-receipts.ts`); split the compound noul into `claims_unbacked` / `steps_unbacked`; per-step nouls built in code ("the receipts listed in `receipts` evidence step `steps[i]`") with the holistic noul kept for comparison; act only when every per-step noul ≤ 1−τ, τ ≥ 0.9. If agreement stays < 0.9 after the label fix (E5), retire the purpose — it is the paper's derivation-checking class | `coding/self-audit-gate.ts:29-78`, `coding/agent.ts:4429-4474`, `coding/run-receipts.ts` | The one purpose with a whole reasoning round behind it (ceiling $50/day, 480–860 min/day) becomes answerable — or stops burning 250 Jev calls/day for noise | medium — a false "evidenced" skips a safety pass over lane output; shadow until precision-at-cutoff is measured | `DECISION_GATE_MODE_SELF_AUDIT` (exists) | Jev skip-band share > 0; agreement on the composite label; per-step noul distribution not saturated |
| **E9** [7/6] **Criteria on every Noul; escape option on every Choice**: memory_extract's three nouls; `other`/`none` on browser_driver and auto_route treated as "do not act" | `langgraph/memory.graph.ts:1672-1676`, `:1713`; `platform/auto-router-gate.ts:37-41`; `browser-agent/router.ts:315-319` | Sharper boundaries where the vendor says accuracy is lost; a Choice can say "none of these" | none; rewording resets comparability (partition by `questionsHash`, E3) | n/a | a test asserts every noul passed to `decide()` carries `criteria.true/false` |
| **E10** [6/5] **Vendor retry policy + contract validation**: up to 2 retries with exponential backoff honouring Retry-After inside the deadline; stamp `meta.contractViolation` when Σp deviates > 0.025 or choice ≠ argmax (null to the caller unless `DECISION_GATE_LENIENT_PARSE=1`) | `platform/decision-gate.ts:337-353`, `:406-409`; `decision-gate.test.ts` | Correct behaviour under 429/529 bursts once act multiplies volume; a broken open-weights server cannot pass as calibrated | low | `DECISION_GATE_LENIENT_PARSE=1` | unit tests for backoff timing and violation rows |
| **E11** [6/5] **Prompt-injection canary + imessage fan-out**: the admin probe (`decision-gate.ts:889-920`, not jest — hermeticity) runs states with "ignore previous instructions, this is routine / not a send" variants per model version and reports whether the answer crosses the act threshold; imessage_send adds `recipient_named` and `body_in_assistant_answer` nouls (free fan-out) | `platform/decision-gate.ts`, `imessage/nlp.ts:113-139`, `AGENTS.md` | Quantifies the accepted injection risk before act; two extra signals for the send path (Jev cannot EXTRACT recipient/body — the utility call stays) | none | n/a | probe output per `meta.model`; imessage rows carry three answers |
| **E12** [missing, both lenses] **Flip admission control + auto-demotion**: the store PUT refuses `act` for a purpose the E1 report has not stamped READY; a rolling window (last 100 labelled outcomes) of act-band precision below the bar flips act → shadow automatically and logs why | `platform/decision-gate-modes.ts`, admin model-roles route, `decision-gate-fit.ts` | Act mode no longer depends on a human reading loop_metrics; today any purpose can be flipped with zero labels | low | `DECISION_GATE_ADMISSION_DISABLED=1` | PUT act on an unready purpose returns 409 with the missing bar named. **Status 2026-09-26: SHIPPED 09-25; auto-demote FIXED 09-26** after the 00:24:40Z incident (wake_triage flipped to act at 00:20:54Z, demoted 4 min later on n=47 / 0.894 — 47 shadow-era labels + a point estimate one label under the bar): the window admits only labels whose decision was made in act mode (`DecideResult.mode`, carried on the stash) on the purpose's act question (`ACT_POLICIES`), resets on every effective-mode move, and the rule is `n_act ≥ 30 AND wilsonUpper95(k, n_act) < bar − margin` (23/30 demotes, 42/47 does not — the math is in the block comment in `decision-gate-modes.ts`); per-purpose bar `DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_<PURPOSE>`, `DECISION_GATE_AUTO_DEMOTE_MARGIN` (default 0); the `decision_gate_demoted` row carries `nAct / lowerBound / upperBound / margin / windowSince / windowScope:'act_period'`. |
| **E13** [missing] **Gate infra alert**: hourly backend share per purpose, leg timeouts, 429 count, and "stash lost" (decisions without an outcome row after N hours) → `[INFRA ALERT]` wake in the Fleet Supervisor's infra watch | `platform/loop-metrics.service.ts`, supervisor infra watch | A Jev key expiry or 429 storm no longer degrades silently to the 0/1 readout with a throttled warn (`decision-gate.ts:719`) | none | existing infra-watch switch | simulate a bad key in the probe → alert row |
| **E14** [missing] **Redacted state snapshot for offline replay**: short-TTL separate table, purposes without user text first (self_audit, delta_material, wake_triage), so question rewrites and backend swaps replay against stored labels instead of restarting the shadow clock | new table + `decision-gate.ts` | Every E7/E8/E9 rewrite and the open-weights leg (§7) can be back-tested in hours, not weeks; the patience plan already requires a replay corpus | privacy — owner Q1 in the patience plan governs user-text purposes | `DECISION_GATE_STATE_SNAPSHOT_DISABLED=1` | replay script reproduces stored answers on the same backend |
| **E15** [missing] **Human-adjudicated label sample**: ~50 wakes + ~30 self-audit finals adjudicated once (the paper settled disputes with blinded human adjudication, App. I) to separate Jev-wrong from label-wrong on the 4/16 and 9/9 disagreements; record the envelope class per purpose in AGENTS.md | `AGENTS.md`, eval doc | The only way to know which side of the disagreement to fix | none | n/a | an adjudication table with per-row verdicts |
| E16 [4/3] Permuted duplicate Choice question to measure order flips (paper §6: 3.25–11.14%) | `router.ts`, `auto-router-gate.ts` | Detects instability before act; average if flips > 3% | none | n/a | deferred until a Choice purpose carries traffic |
| E17 — dropped: per-purpose post-hoc temperature for Jev | — | paper §6: transfer uneven, worsened 2 of 3 tasks; no labels to fit against; revisit only if E1 shows ECE > 0.1 at n ≥ 200 | — | — | — |
| E18 — dropped: open-weights leg this week | — | see §7; pointless before E1 exists to judge it | — | — | — |

Suggested order (what unlocks what): day 1 E2 + E4 + E6; day 1–2 E3; day 2–3 E1; day 3 E5; day 4–5 E7 + E9; then E8,
E12, E13; E11/E14/E15 as capacity allows. No flip this week.

Status lines (updated by the implementing agents; one per item, newest first):

- **E12 auto-demote — FIXED 2026-09-26 (incident 00:24:40Z: a 4-minute-old flip demoted on 47 shadow-era labels at 0.894 vs 0.9).**
  The owner flipped wake_triage to act at 00:20:54Z ("start flipping things and monitoring"); the rolling window, which never
  looked at the decision's mode, had 47 shadow-period labels in hand and a point estimate one label under the bar, and wrote
  the store row back to shadow at 00:24:40Z. Two changes in `decision-gate-modes.ts` + the call site in `decision-gate.ts`:
  (1) the window admits only labels whose DECISION was made in act mode (`DecideResult.mode === 'act'`, the mode the answer
  was used under, carried on the stash for deferred labels) on the purpose's act question (`ACT_POLICIES[purpose].question` —
  prod showed the only act-mode labelled in-band wake_triage rows were the two decision-time code-flag nouls, always agreed),
  and it is cleared whenever the purpose's effective mode moves (store refresh on any box, the admin PUT, a demotion) — never
  on a failed read. (2) The breach test is a confidence bound: `demote iff n_act ≥ 30 AND wilsonUpper95(k, n_act) < bar − margin`
  (the 95% Wilson interval lies wholly below the bar). Why the upper and not the proposed lower bound: `LB < bar − 0.05` at
  n=30 demotes 29/30 (LB 0.833) — a purpose at exactly 0.9 would be demoted 96% of the time at its first 30 act labels (79%
  at a true 0.95). Boundaries at bar 0.9: n=30 → ≤23/30, n=47 → ≤38/47, n=100 → ≤84/100; the incident's 42/47 (UB 0.954) does
  not demote — 0.894 vs 0.9 is the readiness report's call, not a 47-label window's; false demotion ≈ 3–4% per check at a
  true 0.9, a true 0.8 is caught 62% at n=47 / 87% at n=100. Per-purpose bar `DECISION_GATE_AUTO_DEMOTE_MIN_PRECISION_<PURPOSE>`,
  `DECISION_GATE_AUTO_DEMOTE_MARGIN` (default 0 — with the upper-bound test no counterweight is needed; raising it only makes
  the net more lenient); `decision_gate_demoted` meta gains `nAct / lowerBound / upperBound / margin / windowSince /
  windowScope:'act_period'`; the log line prints the same. Known limit (not fixed here): for wake_triage in act, the act
  question's in-band decisions are PARKED (`acted:true`, `actual:null`) and never labelled, so n_act only accrues from
  in-band decisions the consumer did not act on — the net is honest but slow for that purpose until parked wakes are labelled
  at their eventual delivery. Kill switch `DECISION_GATE_AUTO_DEMOTE_DISABLED=1` unchanged. Pinned in
  `decision-gate-auto-demote.test.ts` (+ `decision-gate-modes.test.ts`, `decision-gate.test.ts`).

- **E1 job — SHIPPED 2026-09-25 (defect fix: the ruler could not run in prod).** The backend image carries no `scripts/` dir
  and no `tsx`, so `npm run decision-gate:fit` only ran from a dev checkout (checkers transpiled it by hand into a throwaway
  container). Now (1) the report is an IN-PROCESS durable cron: `platform/decision-gate-readiness.job.ts`
  `runDecisionGateReadinessOnce` registered by the worker as `decision-gate-readiness` (worker.ts CRON_JOBS; interval
  `DECISION_GATE_READINESS_INTERVAL_MIN` default 360; kill switch `DECISION_GATE_READINESS_JOB_DISABLED=1`; Postgres-leased ⇒
  one worker per firing, never the web boxes; NOT volume-bound so the cron-only box A may claim it). One pure builder,
  `buildReadinessArtifacts` (decision-gate-readiness.ts), serves the job AND the CLI. The job stamps
  `instance:decision-gate/readiness` for EVERY `ACT_POLICIES` purpose (17 — an unlabelled purpose is NOT READY with "no labelled
  outcomes in the window" first; `emptyReadinessEntry`), stores the full report under `instance:decision-gate/readiness-report`
  (`computedAt`, entries, fits, `stampWritten`, `workerId`), and records one `loop_metrics` row per purpose (kind
  `decision_gate_readiness`, value 1/0, meta `{purpose, backend, ready, labels, spanDays, auroc, coverage5, bandN, bandPrecision,
  reasons}`). Write-on-success only: any failure logs and writes nothing (no stamp, no report, no rows); the job never throws.
  `DECISION_GATE_READINESS_STAMP_DISABLED=1` still keeps the stamp unwritten (the report is stored, `stampWritten:false`).
  `GET /admin/model-roles/decision-readiness` now returns the job's latest STORED report + `computedAt` + `job {intervalMin,
  windowDays, disabled}` and never recomputes. (2) The CLI moved to `backend/src/scripts/decision-gate-fit-temperature.ts` so
  `tsc` ships it in `dist/scripts/` (the Dockerfile's `COPY dist` carries it): `node dist/scripts/decision-gate-fit-temperature.js
  --stamp` runs inside the image; `npm run decision-gate:fit` picks the compiled entry when dist exists, else tsx over src. The
  admin flip (E12) is therefore admitted automatically the moment a purpose's bars hold. No purpose moved to act.

- **E7 — SHIPPED 2026-09-25 (shadow; act unchanged).** `platform/wake-triage-request.ts` builds the request: v2 (default) puts
  code-computed fields first — event-kind histogram, `any_row_is_question_or_request` / `any_row_addressed_to_supervisor` /
  `any_row_reports_failure_or_block` / `any_row_guard_replaced_final` / `any_row_owner_facing`, distinct sources, event ages,
  `source_lanes` (bounded fail-open lookup of ≤3 source lanes: coding status + last agent run status/age/error head,
  `hooks.service.ts lookupWakeSourceLanes`, 1.5 s wall clock) — then the prose summary LAST, capped 4000. Questions:
  `needs_turn_now` (v1 text verbatim) + `disposition` {ack, coalesce, act_now, escalate_owner} + `addressed_to_supervisor` +
  `contains_failure_or_block` + `urgency` score. The park is untouched (act still keys on `needs_turn_now` alone, bounded,
  never re-triaged on re-delivery). Labels: the two batch-property nouls close at decision time from the code flags;
  `disposition` / `urgency` are labelled at run finalize next to `needs_turn_now` (`decision-outcome-labels.ts`
  `deriveWakeTriageV2Actuals`: owner escalation → `escalate_owner`/3, platform action → `act_now`/2, note → `ack`/1, no-op →
  `ack`/0; a `coalesce` prediction agrees with an `ack` actual). Per-option thresholds `DECISION_GATE_THRESHOLD_WAKE_TRIAGE_<OPTION>`
  (`decisionOptionThreshold`) feed only the shadow "v2 park:…" readout in the outcome note. Every decision row carries
  `meta.questionsHash` (`hashQuestions`) so E1 can partition v1 vs v2 rows. Kill switch `DECISION_GATE_WAKE_TRIAGE_V2_DISABLED=1`
  restores the v1 request byte-for-byte (pinned by `wake-triage-request.test.ts` + `hooks.service.test.ts`). Board-digest act
  semantics (§8) still an owner decision.
- **E8 — SHIPPED 2026-09-25 (shadow; act stricter, never looser).** Receipts now carry scrubbed ≤200-char `argsHead` /
  `resultHead` in memory (`run-receipts.ts receiptHeads`, attached at the agent.ts receipt seam; never persisted; bearer/sk-/ghp_/
  xox*/AKIA/`*_TOKEN=` shapes masked). `coding/self-audit-gate.ts` v2 request: plan steps as objects,
  `completed_steps_under_review` by position, receipts with heads, `final_summary` LAST; questions = `unevidenced` (v1 verbatim) +
  `claims_unbacked` + `steps_unbacked` + `step_<k>_evidenced` per reviewed step (cap `DECISION_GATE_SELF_AUDIT_STEP_NOULS`,
  default 12, by position so the questionsHash depends only on the count). Act (still shadow): under v2 a skip requires the v1
  condition AND every per-step noul ≥ τ AND both split nouls ≤ 1−τ (`selfAuditV2WouldSkip`; the readout rides the outcome note).
  Labels (`recordSelfAuditStepOutcomes`, called from the agent.ts flush after the sibling-owned holistic label): step_k ⇔ that step
  still completed after the round, `steps_unbacked` ⇔ any reviewed step reopened, `claims_unbacked` ⇔ the composite label the flush
  computed. Kill switch `DECISION_GATE_SELF_AUDIT_V2_DISABLED=1` restores the v1 request byte-for-byte (pinned by
  `self-audit-gate.test.ts`). The retire decision (§8 item 3) waits on the E1 report over v2 rows.

## 5. New decision points (top 10)

Swept: every `utilityChat()` site (40 non-test), every `classify*/should*/is*/detect*` heuristic and `*_MS` timer in
chat-agent/coding/platform/fleet, priced on 7-day telemetry. Ranking = (USD/day + human-visible seconds + supervisor
hours) × how far inside the paper's envelope the question sits. Everything below is shadow-first with a harness label
from day one; none may become the sole arbiter of merge/publish/money/other-users'-data actions (AGENTS.md:1571).

| # | Decision point | Question / state | Files | Expected gain | Risk | Kill switch | How to verify |
|---|---|---|---|---|---|---|---|
| **N1** [7/7] **Guard-strike adjudication** — the nightly adjudicator sends ambiguous strikes to ONE utilityChat batch capped at 30/night (`fleet/strike-adjudication.service.ts:56`, `:270-271`); 462 strikes/day, 128 adjudicated (99 tp / 20 fp / 8 unclear). **STATUS 2026-09-25: SHIPPED as purpose `guard_strike`, SHADOW** — pass 3 of the nightly job (`gateStrikes`); the pass's verdict is the outcome label; act semantics (adjudicate the over-cap remainder, never `unclear`) wired but mode stays shadow; kill switch `DECISION_GATE_GUARD_STRIKE_DISABLED=1`, cap `DECISION_GATE_GUARD_STRIKE_NIGHTLY_CAP` | Choice {true_positive, false_positive, unclear} over {seam, kinds, struck line ≤1k, compared receipts/ids ≤1.5k, later-clean-finalize flag}; numeric diffs pre-computed in code (jaggedness #2) | `fleet/strike-adjudication.service.ts`, `platform/decision-gate.ts`, `decision-gate-fit-temperature.ts` | Removes the 30/night cap (all ~330 ambiguous strikes/day for ≈$0.015/day); a labelled precision series per guard; **the calibration testbed for the whole gate** — the only purpose with a labelled corpus on day one | nil — a wrong verdict mislabels telemetry; `unclear` still goes to the reasoning batch; labels are LLM-adjudicated, not ground truth (paper: label noise dominates near the ceiling) | `DECISION_GATE_MODE_STRIKE_ADJUDICATE` | agreement vs the existing 99/20/8 verdicts on the first night |
| **N2** [6/7] **Sweep pre-triage** — fleet sweep every 120 min (`platform/supervisor.service.ts:184`), project sweeps every 60 min (`fleet/project-supervisor.service.ts:143`) fire a full reasoning turn regardless: 143–158 sweep turns/day, 53–58% no-op, p50 164–405 s, $0.256 each. **STATUS 2026-09-25: SHIPPED as purpose `sweep_triage`, SHADOW** — `platform/sweep-triage.ts` (code-computed snapshot: runs/hook events/asks/tickets/status card/last note) called from `processDueScheduleRow` before `fireScheduleTarget`; the stash rides the fired sweep and `decision-outcome-labels.ts` labels it (acted ⇒ needed the turn); act semantics (skip → `skipped:sweep_quiet:<n>` + cap refund + `schedule_sweep_skip`, heartbeat floor `DECISION_GATE_SWEEP_HEARTBEAT_TICKS`) designed and wired but NOT enabled; kill switch `DECISION_GATE_SWEEP_TRIAGE_DISABLED=1` | Noul "since the previous sweep something moved that requires the supervisor to act now" over code-computed {status-card diff (`fleet/project-status.service.ts:49-60`), events since lastFiredAt, open asks, last sweep note} ≈ 6k chars; skip = `skipped:sweep_quiet` + cap refund; heartbeat floor every Nth tick | `coding/schedule.service.ts:2806-2812`, `platform/sweep-doctrine-rebuild.ts:69`, `fleet/project-status.service.ts`, `platform/decision-outcome-labels.ts` | ~$12/day and 2.6–5 h/day of supervisor busy time at 50% coverage; $23/day and 5–10 h/day full — the saturation lever the 2026-09-13 review named | a missed stuck lane waits one cadence (60–120 min), bounded by the heartbeat and by hook wakes (alarm rows never pass through); same "needs a turn" question that shows 4/16 confident errors on wake_triage — state must be code-computed | `DECISION_GATE_MODE_SWEEP_TRIAGE` | label = `classifySupervisorNote` of the fired turn (the WI-C pattern); ≥1 week shadow |
| **N3** [4/6] **Coding-memory fold gate** — `updateCodingMemoryAsync` fires after every coding run (388/day): session summary 30 s, project fold 60 s thinking (85/day at p50 22 s), user prefs 30 s, run journal 45 s (`coding/coding-memory.service.ts:509-650`, `coding/run-journal.service.ts:113`); the chat memory_extract gate covers none of it. **STATUS 2026-09-25: SHIPPED as purpose `coding_memory_fold`, SHADOW** — `coding/coding-memory-fold-gate.ts`: ONE prefill of per-leg nouls (`session_state_change` / `project_fact` / `user_preference` in `updateCodingMemoryAsync`; `journal_worthy` in `writeRunJournalEntryAsync`) over the prompts' own slices plus heads of the EXISTING docs — in shadow the gate is started before the legs and never awaited (labels land via the promise; act awaits it ≤ 3 s); each leg records an outcome row whose actual is the HARNESS-MEASURED, key-order-independent content diff of the stored doc (jsonb reads keys back (length, bytes)-sorted — canonicalised before compare; changed / noop; LLM or parse failure = unlabelled; the session leg is a rolling paraphrase so its label reads ≈ always-true — the informative legs are project / user / journal); act semantics (skip a leg at noul ≤ 1−0.8, no utility call, doc untouched) wired behind `result.mode` but mode stays shadow; kill switch `DECISION_GATE_CODING_MEMORY_FOLD_DISABLED=1` | three nouls in one prefill (new command/path/decision; durable preference; session goal/state change) over the same ≤1.5k-char slices the prompts use | `coding/coding-memory.service.ts`, `coding/run-journal.service.ts`, `langgraph/memory.graph.ts` | 30–60 min/day of utility-seat time, ~$0.5–1/day; fewer rewrites of unchanged memory; less utility contention during 429 storms (`seat_fallback` 131/day) | reference-free "worth remembering" is the paper's "Not supported" prose class — expect weak AUROC; fail-open runs the fold | `DECISION_GATE_MODE_CODING_MEMORY_FOLD` (kill `DECISION_GATE_CODING_MEMORY_FOLD_DISABLED=1`) | label = the gate's OWN outcome row per leg: harness-measured, key-order-independent content diff of the stored doc (`changed`/`noop`; LLM/parse failure = unlabelled) — not `memory_extraction` |
| **N4** [6/6] **Re-home auto_route at the L2 checker site** — `isSimpleQuestion` is a regex (`chat-agent/chat-agent.service.ts:1862-1867` → `platform/auto-router.ts:56-58`) that picks the 75 s vs 300 s checker wait and the step-0 fast path; the Double Checker always spawns at `max` (`:1996`). **STATUS 2026-09-25: SHIPPED at the checker site as its OWN purpose `checker_route`, SHADOW** (review fix, same day: the first cut shared `auto_route`, whose flip-readiness stamp measures only the NEWEST questionsHash partition — with the router's `level` rows and the checker's `depth` rows landing concurrently the `--stamp` verdict flipped between sites, so the admin PUT could admit the router to act on checker evidence; a separate purpose puts each site in its own (backend, purpose) readiness group — pinned in `decision-gate-fit.test.ts` — and removes the extra `_CHECKER_ACT` arming env) — `chat-agent/checker-route-gate.ts`: Choice `depth` {simple_lookup, ordinary, contestable, unclear (E9 escape, never acts)} + noul `needs_live_web` over {message ≤2k, last user turn ≤1k} (no workspace flag — the chat run has no workspace signal; the regex passes `hasWorkspace:false` too), asked CONCURRENTLY with the regex on every human L2 turn that runs the checker (`decide()` fired beside `isSimpleQuestion`; shadow never waits — the request path awaits the gate ONLY when `decisionMode('checker_route') === 'act'`, and acting still keys on the RESULT's mode). Labels at the chat finalize from the turn's facts: `depth` actual = simple_lookup ⇔ no lead tool round AND final ≤ 800 chars; a HEAVY turn (≥ 3 lead tool calls or final ≥ 2,500 chars) = contestable when the checker draft was MERGED (mid-loop inject / inline reconcile) and **null (unknown)** when it was not — whether the draft reached the answer is decided by the wait cap the regex (or the gate, in act) picked, so the old "ordinary otherwise" rule could essentially never label a regex-simple turn contestable and biased shadow agreement toward the regex (review non-blocking 1; the confound is now excluded from the pairing rather than mislabelled, and `extra.regexSimple` still lets the readout stratify); a light turn is ordinary regardless of the merge; `needs_live_web` actual = the lead fired a web tool; note carries `regex:simple|deep; merged; late; tools; web; chars`; empty finalize ⇒ actual null. Registry: `DecisionPurpose`, `DECISION_PURPOSES`, `ACT_BAND_DEFAULT_THRESHOLD` 0.7, `ACT_POLICIES` {question `depth`, choice_high 0.7}; no machine-run label (`PURPOSE_QUESTION` notes it). Act: confident simple_lookup → 75 s path + checker `reasoning_effort:'high'`; confident contestable → full wait; the checker is never skipped. Mode `DECISION_GATE_MODE_CHECKER_ROUTE` (shadow), threshold `DECISION_GATE_THRESHOLD_CHECKER_ROUTE`, kill switch `DECISION_GATE_CHECKER_ROUTE_DISABLED=1`. Wiring pinned in `chat-agent.service.test.ts` (shadow never awaits `decide()`; L1/L3/machine turns/off/kill switch never fire it; checker at `max`; recorder once at finalize with `acted:false`, `failed:true` on an empty finalize). Patience plan Phase 1a riders in the same commit: `patience_auto_only` SystemSetting reader (`rate-limit.service.getPatienceAutoOnly`, env boot default `PATIENCE_AUTO_ONLY`, default OFF; SSE-seam override + §3.4 allowance/demotion wired behind it), the label window (`shadowAutoRouteAgainst` — fires ONLY for `modeSource === 'picked'` (§4.2 "only picked counts as U"; review blocking 2: unsignalled sends would have landed as `user_explicit` rows with `actual` = whatever level the composer held, swamping the router's readiness partition and costing one DeepSeek readout per send), gated in the controller AND inside the function, and only once the send is admitted past the deep-research reserve (a refused Level 3 send is not a label); the web client does not send `modeSource` yet, so egress is ZERO until it ships — exactly the plan's ordering; identical repeated sends answer from the E3 memo (`memo:true` spec opt-in); `LABEL_WINDOW_DECISION_SPEC=deepseek-flash` until Q1, `LABEL_WINDOW_SAMPLE_PERCENT`, kill `DECISION_GATE_AUTO_ROUTE_LABEL_WINDOW_DISABLED=1`), outcome rows carry `heuristic` / `segment` / `modeSource` / `reasonKey` / `clamped` / `source`, per-option `DECISION_GATE_THRESHOLD_AUTO_ROUTE_DEEP_RESEARCH` (generic env can never lower the 0.85 floor), `run_spend`/`chat_search_usage` stamps carry `mode` + `routingSource`, loop_metrics kind `deep_research_quota_rejected {scope, anon, …}`, `quotaClientIp` (env `QUOTA_TRUSTED_PROXY_HOPS`, getClientIp untouched), the Telegram guard (`linkedUserKind` — fail-closed, but the copy branches: the kids message only for a real child; a deleted user's stale link and a transient DB error each get a neutral line — USER-VISIBLE for linked child accounts, who now get the kids reply instead of the adult agent, per plan §3.5), the kid lookup hoisted above routing. NOT done: acting-backend pin by `spec`, the platform-seam allowance/reserve, the drain reserve + migration, the schedule/orphan clamp, Zod defaults `'auto'`, the frontend `modeSource` send, the compose shell pin, AR0926/XFF0926, the E2E driver (Phase 1a items 1 (partial), 3 (pin), 7–10, 15–17, 19). | Choice {simple_lookup, ordinary, contestable} + noul needs_live_web over {message ≤2k, last user turn ≤1k, hasWorkspace}; simple → 75 s path and checker at `high` (never skip the checker on the gate alone) | `chat-agent/chat-agent.service.ts`, `platform/auto-router-gate.ts`, `platform/auto-router.ts` | Real traffic for a purpose with 1 row/7 d; latency on simple human L2 turns (no 10 s late-wait, no 150–197 s reconcile); rides the owner's patience program rather than competing with it | skipping the checker loses the L2 second opinion — downgrade effort only; fail-open = regex | `DECISION_GATE_MODE_AUTO_ROUTE` (exists) | shadow-compare vs the regex verdict; the patience plan's back-test bars (≥3,000 paired rows, L3 recall ≥0.70, over-escalation ≤5%, ECE ≤0.10, coverage ≥60%, p95 ≤1,200 ms) |
| **N5** [5/6] **Action-verifier: deterministic claim mining first, per-claim noul, LLM extraction only as fallback** — `extractActionClaims` is a 30 s serial utilityChat per surface + one per tracked tool-args blob on the pre-delivery path of every supervisor wake (`platform/action-verifier.ts:233-252`, `:2543`, `:2569`). **STATUS 2026-09-25: SHIPPED as purpose `claim_evidenced`, SHADOW** — `platform/claim-evidence-gate.ts`; `computePhantomClaims` mines `mineGateClaimCandidates` first (reachability fix 2026-09-26 — the gate first shipped on `mineReceiptIdiomClaims` alone, which mined 0 claims in 0 of the 60 most recent prod supervisor notes, so the gate recorded 0 rows all-time; the candidate miner reads the fleet's tool-name receipt lines, receipt-anchored completed-action verbs in any person, and the first-person rule without its person requirement) and starts ONE request with a `claim_<k>_evidenced` noul per mined claim (by position, cap `DECISION_GATE_CLAIM_EVIDENCE_MAX_CLAIMS` 8) over the code-computed executed pool (tool / ok / staged / ids ≤1.5k + per-claim `cited_id_appears_in_a_receipt` / `a_successful_receipt_of_this_kind_exists`), CONCURRENTLY with the utilityChat extractor (never awaited in shadow — zero latency); settled after the tier chain: label per claim = the verifier's own verdict (convicted ⇒ false, exonerated ⇒ true, never surfaced ⇒ null; note carries `lane:llm|miner|gate` + clean/struck). Act semantics (await the gate in place of the LLM call; every noul ≥ τ 0.9 ⇒ the miner's claims stand, LLM lane skipped, tier chain unchanged — the HIGH-side act band, `ACT_POLICIES` kind `noul_high` / `NOUL_HIGH_PURPOSES`) designed and wired but NOT enabled; kill switch `DECISION_GATE_CLAIM_EVIDENCED_DISABLED=1`. Not wired on the sub-floor (<40-char note) path. | one noul per mined claim "this claim is evidenced by the run's receipts (matching tool, id, target)" over {claim ≤300, receipts ≤1.5k}; LLM lane only when the miner finds nothing AND first-person action verbs are present | `platform/action-verifier.ts`, `platform/decision-gate.ts` | 1–3 utility calls (1.4–30 s) off every supervisor wake's finalize path: ≈30–90 min/day aggregate pre-delivery latency, ≈$0.3–1/day; measurable precision on the phantom-receipt class (61 `machine_wake_reject_back` strikes/day) | the verifier is observe-only since 09-11, so verdicts enforce nothing; Jev cannot extract; evidence checking is the class to cascade, not trust — the gate only decides which claims need the LLM | `DECISION_GATE_MODE_CLAIM_EVIDENCE` | pre-delivery latency per wake; agreement vs the LLM extractor on the same notes |
| **N6** [4/6] **Agent-message drain triage** — report-ups queued via `send_chat_message` drain as a full detached turn (`chat-agent/chat-agent.service.ts:717-830`); on supervisor chats 157/day, 58 no-op, the SLOWEST class (p50 475–697 s); wake_triage never sees them. **STATUS 2026-09-25: SHIPPED as purpose `drain_triage`, SHADOW** — `platform/drain-triage.ts` (`preTriageDrainBatch`: code-computed state — rows / distinct senders / ages / `any_row_is_question_or_request` / `sender_awaits_reply` / failure cues / report-only cues / superseded markers / hook depth / `open_directives_on_ledger` from the supervisor state doc / `user_rows_waiting_behind`; bodies LAST ≤4k) called from `drainChatQueue` for AGENT batches only (user / webhook / schedule rows never enter); the stash rides `ChatAgentRunArgs.decision` and `decision-outcome-labels.ts` labels it at the drained run's finalize (acted ⇒ `act_now`, else `ack_only`; a `coalesce` prediction agrees with `ack_only` — `MACHINE_RUN_CHOICE_LABELS`). Act semantics (park a confidently quiet batch: Redis marker `chat:draintriage:<chatId>` = triagedAt + retryAt, `DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN` 15, never re-triaged, never when a user row waits behind it, the orphan sweeper re-drains after the park; per-option thresholds `DECISION_GATE_THRESHOLD_DRAIN_TRIAGE_<OPTION>`) designed and wired behind `result.mode` but NOT enabled; kill switch `DECISION_GATE_DRAIN_TRIAGE_DISABLED=1`. | Choice {ack_only, coalesce, act_now} over the batched agent rows ≤4k + open directives count + "sender awaits a reply"; act = leave rows pending with `triagedAt` + retryAt (the hook idiom) | `chat-agent/chat-agent.service.ts`, `chat-agent/message-queue.service.ts`, `platform/hooks.service.ts` | $7.5–15/day and 4–11 h/day of supervisor time | delaying a lane's report to its supervisor is the friction class the 09-11 flip removed; wake_triage's 5 disagreements were all wakes that then acted via `send_chat_message`/`notify`; state is entirely lane-authored | `DECISION_GATE_MODE_DRAIN_TRIAGE` | shadow only, after N2 proves the code-computed-state pattern; never gate USER rows |
| **N7** [5/5] **Superseded-firing gate** — busy-parked schedule firings re-arm every ~3 min (`schedule_busy_skip` 1,154/day, `coding/schedule.service.ts:3534-3611`) and run in full when the lane frees even if the finished run already did the work. **STATUS 2026-09-25: SHIPPED as purpose `firing_superseded`, SHADOW** — `coding/firing-superseded-gate.ts` (`preGateParkedFiring`: recurring + `promptSetBy` machine/system + not owner-subscribed + `busySkips > 0` + a run COMPLETED on the lane since the schedule last fired; state = prompt ≤2.5k, the finished run's final ≤1.5k with code-counted receipts, minutes since, parked minutes, next cadence) called from `processDueScheduleRow` after the sweep triage (one stash per firing); the stash rides the fired run and `decision-outcome-labels.ts` labels it via `PURPOSE_CHOICE_LABELS` (real work ⇒ `fire`; no-op ⇒ `drop_superseded`, `merge_into_next` agrees); the "parked firing claimed after a finished run" metric is `schedule_parked_claim` (gate on or off); act semantics (skip → `skipped:superseded` / `skipped:merged_next`, cap refund, busySkips reset, `schedule_superseded_skip`) wired behind `result.mode` but NOT enabled; kill switch `DECISION_GATE_FIRING_SUPERSEDED_DISABLED=1`. **Review follow-ups (2026-09-25):** a finished run that predates the parked window (`finishedAgoMin > busySkips × 3 + 10` min — the blocker failed / was cancelled and an older hook wake completed) is `finished_before_park`: not judged, facts still on the claim row for filtering; the label is BIASED toward `fire` (it measures "the run did work", not "the work was needed" — a firing that repeats the finished sweep and re-reports the same facts labels `fire`, understating drop precision) and needs a secondary signal (final-text similarity / no new mutating target) before any act consideration; the schedule.service wiring (claim metric, act skip + refund, fail-open) is pinned by `schedule.service.test.ts` | Choice {fire, drop_superseded, merge_into_next} over {schedule prompt ≤2.5k, finished run final ≤1.5k, minutes since, next fire in N min} | `coding/schedule.service.ts`, `platform/hooks.service.ts`, `coding/dormancy-gate.service.ts` | unmeasured share; if 10% of 256 coding firings/day ≈ $30/day and ≈4 h/day of lane time | dropping a firing that carried a real ask — never gate owner-authored or one-shot schedules; the finished final is lane-authored text | `DECISION_GATE_MODE_FIRING_SUPERSEDED` | add the "parked firing claimed after a finished run" metric FIRST; label = fired run acted vs "no change" |
| **N8** [5/4] **Reflection pre-choice** before the 45 s Double-Checker consult on a 3× failure streak (`coding/reflection.ts:85-130`; `tool_derail_break` 33/day). **STATUS 2026-09-25: SHIPPED as purpose `reflection_route`, SHADOW** — `coding/reflection.ts` (`REFLECTION_ROUTE_QUESTIONS`, `buildReflectionRouteState` over the packaged StreakEvidence): the gate runs CONCURRENTLY with the consult inside `consultCrossCheckerOnStreak` (no latency added for a normal consult; a FAST consult — keyless seat / seat error — waits ≤ 250 ms `REFLECTION_ROUTE_POST_CONSULT_WAIT_MS`, then labels async); the label is the remedy the consult's advice text prescribed (`classifyConsultAdvice`, note `label:consult`) or, when unclassifiable, the lane's next tool call when it was the intended different tool (`label:next_tool`, recorded at the next completed turn via `agent.ts` → `labelReflectionRoute`; otherwise unlabelled); act semantics (await the gate, skip the consult on a confident non-needs_diagnosis route, render `REFLECTION_ROUTE_HINT` in the breaker notice) wired behind `result.mode` but mode stays shadow; kill switch `DECISION_GATE_REFLECTION_ROUTE_DISABLED=1` | Choice {retry_with_corrected_params, different_tool, deterministic_framework, needs_diagnosis} over the StreakEvidence already packaged (≈1.8k chars); consult only on needs_diagnosis | `coding/reflection.ts`, `coding/agent.ts` | 25–50 min/day of lane wall time; next step in <1 s instead of after the consult | a typed line is generic where the consult's value is its advice TEXT; the second trip still consults | `DECISION_GATE_MODE_REFLECTION_ROUTE` (kill `DECISION_GATE_REFLECTION_ROUTE_DISABLED=1`) | agreement vs the remedy the consult's advice text prescribed (`classifyConsultAdvice`; grounding reads such as read_file/ls/grep never count as "a different tool"), else the lane's next tool when it was the intended one |
| **N9** [2/4] **Machine-wake reasoning-effort score** — every machine wake runs at `max` (≈12 min of thinking on glm-5.3 vs ≈3 at `high`, `chat-agent/human-turn-effort.ts:6-9`); 631 supervisor machine turns/day, 51% no-op, payloads mostly 1–2 KB report-ups. **STATUS 2026-09-25: SHIPPED as purpose `wake_effort`, SHADOW ONLY** — `platform/wake-effort.ts` (`startWakeEffortGate` from the chat-agent machine path, run CONCURRENTLY with the orchestrator call — never awaited, no latency; state = code flags + wake head ≤ 2 KB; score 0–2 `deliberation`); the finalize labels it via `decision-outcome-labels.ts` (0 no-op / 1 note / 2 acted-or-escalated, `agreed` = the binary ≤ 1 call, note carries run length + turn-ledger cost, `acted` when effort was lowered); act semantics BUILT and DOUBLE-LOCKED: `effortProviderExtra(model, 'high')` on built-in glm/deepseek seats at round(score) ≤ 1 with confidence ≥ 0.9, alarm-marker wakes pinned to max, applied only on `result.mode === 'act'` AND the explicit owner switch `DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=1` (default OFF — the §8 "machine wakes keep max" directive stands; an act flip alone changes no effort); kill switch `DECISION_GATE_WAKE_EFFORT_DISABLED=1`; `ACT_POLICIES.wake_effort` = `score_low` (maxScore 1) so the readiness report scores the act band | Score 0–2 "how much deliberation does this wake need" over the wake head; apply as `providerExtra.reasoning_effort` only at level ≤1 with q ≥ 0.9; alarm rows pinned to `max` | `chat-agent/human-turn-effort.ts`, `chat-agent/chat-agent.service.ts:2505` | order $30–60/day and up to ~50 h/day of aggregate thinking — **the largest lever found** | explicit owner directive "machine wakes keep max (nobody is waiting)"; the 09-13 review found the kimi-k3 supervisor seat at 58% zero-tool finals — lower effort could worsen finals | owner ruling (§8) | not to be built without the ruling |
| **N10** [4/3] **Tool-intent attribution** as a Choice over offered tools instead of the regex detector (`coding/tool-preflight.ts:126-160`; `guard_miss tool_intent_attribution` 508/day). **STATUS 2026-09-25: SHIPPED as purpose `tool_intent`, SHADOW (telemetry only — no act consumer)** — `coding/tool-intent-gate.ts` (`createToolIntentShadow`, one per run, observed from `agent.ts` at the dispatch site beside the regex detector, fire-and-forget; options = emitted + tools named in the tail + ≤20 recent calls as POSITIONAL keys `option_1..n` so `questionsHash` partitions by option count only; state = reasoning/content tails, tool results excluded; per-run cap `DECISION_GATE_TOOL_INTENT_RUN_CAP` 16); two outcome rows per decision, told apart by `meta.label` — `regex` (the detector's verdict, emitted tool when acquitted; the ONLY label the fit / readiness pairing reads, `decision-gate-fit.ts OUTCOME_LABEL_FOR_FIT`) and `next_call` (the next turn's first tool; the run's LAST tool turn never gets one); kill switch `DECISION_GATE_TOOL_INTENT_DISABLED=1`. **Review follow-ups (2026-09-25):** asked ONCE PER TOOL TURN (the turn's first dispatched call; a batched turn shares one narration — `batch_calls` in the state / `batch N` in the note so the partition is filterable) instead of per call, which had burned the run cap in one batched turn; a ONE-option set (nothing else named, no other recent tool — the first call of nearly every run) is never asked (it was writing an error row + consuming a cap slot per run) | Choice over emitted tool + tools named in the tail + ~15 recent (≤20) over reasoning/content tails, tool results excluded | `coding/tool-preflight.ts`, `coding/agent.ts` | no model time removed; cleaner observe-only series and fewer false reanchor hints | option-set construction fragile | `DECISION_GATE_MODE_TOOL_INTENT` | shadow-compare vs the regex |

Declined after examination (both lenses): **reconcile-or-skip** before the L2 reconcile (the product's L2 promise to a
human and the paper's weak class "resisting an elaborate wrong answer"; max saving ≤150 s, not 197 s, because
`CROSS_CHECK_RECONCILE_MS` already ships at 150 s and late-crosscheck revises the row); **human-turn effort score**
(user-visible quality regression, `low` unmeasured in prod); **drain-extension noul** (~3 replays/day; the deterministic
fix — count active reasoning deltas as progress — is better); **project-brief rebuild gate** (~$0.1/day on the surface
Paul reads); **goal-continue pre-choice** ("is the work done" is the class small heads do worst — self_audit 0/9 is the
live evidence; no metric counts continuation rounds yet — add the metric, do not gate); web-hedge tier, queue fairness,
dormancy/quiet hours, search discipline, owner-question routing, suggested-questions critic, compaction recap
(not judgments, or nothing to remove).

## 6. Act-flip roadmap

**Who flips:** an admin, in Account → Admin → Endpoints → Model roles → Decision gate ("Gate mode per purpose", `PUT
/admin/model-roles/decision-modes`, store-backed, reaches A/B/C within 30 s — `decision-gate-modes.ts`). After E12 the
PUT refuses `act` unless the E1 report has stamped the purpose READY, and a rolling precision breach demotes it. Kill
switches: `DECISION_GATE_DISABLED=1` (everything), `DECISION_GATE_MODE_<PURPOSE>=shadow` (one purpose),
`DECISION_GATE_STORE_MODE_DISABLED=1` (ignore the store).

**Common bar for every purpose** (from the paper §7–§8 and the eval doc §6c): ≥200 labelled outcomes over ≥3 days
after dedupe (E3) and after the last question rewrite (`questionsHash` partition); act-band precision ≥ 0.9 at the
purpose's real cutoff; AUROC(1−confidence vs disagreement) ≥ 0.8; coverage at ≤5% error ≥ 60%; the answering backend
is calibrated (E2) and pinned (E4); the paired cost stamp (E5) shows the shed is real work, not delay.

| Order | Purpose | Bar beyond the common one | Telemetry that proves the flip |
|---|---|---|---|
| — this week | none | — | — |
| 1 | **imessage_send** | ≥30 labelled POSITIVE sends (from the modal confirm/decline, E5) with agreement ≥ 0.95 at the cutoff; recall on real sends ≥ 0.95 | `decision_gate` outcome rows with `actual:true` and `noul > 0.15`; utility-call count per paired-Mac turn drops; no send-modal complaint |
| 2 | **delta_material** | ≥50 labels after the last-run-outcome field lands; material-when-skipped rate ≤ 5% | `schedule_delta_skip meta.immaterial:true` rows; fired-run outcome on the next heartbeat shows no missed status flip |
| 3 | **auto_route** | the patience plan's pre-registered acceptance (paired agreement lower bound > −2 pp on ≥3,000 picked rows, L3 recall Wilson LB ≥ 0.70 on ≥300, over-escalation UB ≤ 5%, ECE ≤ 0.10, coverage ≥ 60%, p95 ≤ 1,200 ms); acting backend pinned by `spec` (`DECISION_GATE_ACT_BACKEND_AUTO_ROUTE`) | the plan's act canary with a concurrent control cohort and stop rule |
| 4 | **wake_triage** | after E7; act-band precision ≥ 0.9 with the false-park class ≤ 5%; the "parked batch absorbed by a later wake" share measured (or the board-digest semantics adopted, §8) | `wake_parked reason:'triage'` rows; hook-origin supervisor turns/24 h fall while `supervisor_action` share rises; hook lag p50 |
| 5 | **browser_driver** | needs volume (0.4/day); ≥50 labels; escape option present | driver pick vs GLM pick agreement; user-facing latency −0.3…0.9 s from E6 regardless |
| 6 | **self_audit** | after E8 and E5; per-step nouls not saturated; agreement ≥ 0.9 on the composite label; τ ≥ 0.9; if not met, retire the purpose | `self_audit_run` count/day vs audited-run count; evidence-guard strikes on un-audited finals stay flat |
| 7 | **memory_extract** | not worth flipping at 9 decisions/day; widen to the coding/project extractors (N3) first, label from `memory_extraction.outcome` | `memory_extraction` rows with `outcome:noop` that the gate would have skipped |

### 6.1 What is actually live (2026-09-26 02:05Z) — and why the rest is not

The table above was the evidence-first order. On 2026-09-26 00:20Z the owner overrode it ("why dont you just start flipping
things and monitoring"); flips were written as the store row `['instance','decision-gate']/modes` (`updatedBy
owner-override:claude-loop`) with an owner-override readiness stamp so the E12 admission stays coherent. The 6-h readiness
cron (first firing 06:18Z) overwrites the stamp with the measured verdict but never reverts a mode; auto-demote is the only
automatic reversal. Sources: the "2026-09-26 decision gate — first flips + auto-demote fix" bullet in `AGENTS.md`,
`memory-bank/crossmodel-activeContext.md` 2026-09-25 23:50Z / 2026-09-26 00:50Z / 01:00Z / 01:30Z entries, and the loop's
02:05Z flip record.

| Purpose | Mode now | Since | Why / what would change it |
|---|---|---|---|
| `sweep_triage` | **act** | 00:20:54Z | owner override; N2 act semantics (skip → `skipped:sweep_quiet`, heartbeat floor `DECISION_GATE_SWEEP_HEARTBEAT_TICKS`) |
| `imessage_send` | **act** | 00:20:54Z | owner override; Jev 30/30 agreement but ZERO positive sends — the ≥30-positives bar cannot accrue without real send traffic |
| `wake_triage` | **act** | re-flipped 01:49Z | flipped 00:20Z, auto-demoted 00:24:40Z on 47 SHADOW-era labels at 0.894 (one label of noise); re-flipped after the act-period auto-demote fix (a1bf00e2, live via 260a091a): the window admits only act-mode labels, resets on every mode move, demotes iff n_act ≥ 30 AND Wilson 95% upper bound < bar − margin. Caveat: parked (in-band) decisions are never labelled, so n_act grows slowly |
| `auto_route` | **act** | 02:05Z | owner override; governs only sends that carry `mode='auto'` (0 rows all-time before the patience 1a label window; the label window fires only for `modeSource==='picked'`, which no client sends yet) |
| `drain_triage` | **act** | 02:05Z | owner override; N6 act semantics (park a confidently quiet AGENT batch `DECISION_GATE_DRAIN_TRIAGE_DEFER_MIN` 15 min; never user rows) |
| `delta_material` | shadow (confirmed 2026-09-26 02:40Z: no store entry → env default) | — | 0 labelled outcomes so far; flips when ≥30 act-period-capable labels hold |
| `self_audit` | shadow | — | v1·Jev ANTI-predictive (accuracy 0.07 on the live pass) — watch v2 (E8), retire the purpose if it stays |
| `wake_effort` | shadow | — | owner lock LIFTED 2026-09-26 (late; "default all chats to auto even supervisors"): act flips through the store mode + READY admission like every purpose; `DECISION_GATE_WAKE_EFFORT_ACT_ENABLED=0` is the env hard disable (was the opt-in owner switch) |
| `memory_extract` | shadow | — | ≈9 decisions/day; E5 labels unexercised in the verification window; widen to N3 first |
| `browser_driver` | shadow | — | 0.4 decisions/day; needs ≥50 labels; E6 concurrency already removes the latency |
| `coding_memory_fold`, `reflection_route`, `checker_route`, `firing_superseded` | shadow | — | N-wave purposes: the ruler says NOT READY on volume for all; `firing_superseded`'s label is biased toward `fire` and needs a secondary signal; `checker_route` acts only on `result.mode` (its own readiness partition) |
| `tool_intent` | shadow | — | telemetry only — there is NO act consumer |
| `claim_evidenced` | shadow | — | 0 decision rows all-time until the 2026-09-26 reachability fix (the gate was fed the first-person miner; it now mines the fleet's receipt idioms, 17/60 recent notes) — no labelled corpus yet |
| `guard_strike` | shadow | — | fires only in the nightly adjudication; unexercised in the verification window |

Still unexercised in production as of the 23:50Z live pass (no traffic / no prod writes): memory_extract E5 labels, imessage
`modal:` notes, browser_driver E6, the E12 admission 409, readout `meta.logits` (Jev answered 100% — no readout rows since
the deploy).

## 7. Open-weights path

**What is verified (HF API, 2026-09-25; existence, licence and serving claims only — accuracy figures are from model
cards and JevBench and were not re-verified):** `alibiserikbay/JevK5` (Apache-2.0; ships a runtime serving a
TypeSafe-style `/v1/systemone`; letter-logit readout with one calibration temperature 1.22 plus a knockout temperature
0.93 for >16 options; ~13 ms/decision on an H100), `JevK5-GGUF` (llama.cpp; Q8_0 matches bf16 on 229/231 public items),
`JevK5-2B/-9B/-Lite`; `TokenRhythm/NeoHorse-Jev-4B` (+GGUF; Apache-2.0; prefill-only Choice/Noul/Score; vLLM, SGLang or
native HTTP; accepts one image); `jaredpalmer/kev-9b` (PEFT adapter) and `taigrr/kev-9b-gguf`; `ZefanCai/Open-Jev-*`,
`openjev/openjev`, `AlexWortega/openjev`. The paper says nothing about any of them.

**When it pays.** Not on cost: Jev is ≈$0.009/day at today's volume and would stay under $1/day at 100× (paper fee ×
measured tokens). It pays for (a) vendor independence — a key expiry or 429 storm today degrades every decision to the
0/1 readout (E13); (b) images — Jev is text-only, NeoHorse takes one image, which matters for browser/computer purposes;
(c) on-box latency for request-path purposes once act mode multiplies calls; (d) the owner's stated end state
(`decision-gate.ts:3-5`: "deploy the open-source alternative once we harden it and prove its impact").

**How to host.** JevK5-GGUF on box C CPU is acceptable for purposes with ≥2 s deadlines (wake_triage, delta_material,
self_audit — all background) but box C was at 90% in the 09-13 fleet review, so it needs its own resource envelope; a GPU
host for imessage_send / auto_route (≤1.5 s budgets). Digby already resolves a registry endpoint with `providerShape
'systemone'` as a seat (`decision-gate.ts:117`, `:242-249`) and any logprobs-capable OpenAI-compatible server via the
readout (`:250`), so the code change is nil beyond E1/E2.

**How to validate (same bars as Jev, no exceptions).** Register the endpoint → run it as the seat's custom fallback in
shadow ≥3 days → seat model ≥7 days shadow → replay against the E14 corpus → the E1 report must show, per purpose,
AUROC/coverage/act-band precision meeting the §6 bar → only then promote. The JevK5 card's own sealed-set drop (33.1%
vs Jev 36.7%) says per-purpose validation is mandatory, not optional. Contract validation (E10) must be strict for a
self-hosted server: a bad softmax must record `contractViolation`, not pass as calibrated.

**Spec pinning — SUPERSEDED (see the 2026-09-26 addendum below).** The original design pinned the acting backend for
each act-mode purpose by `spec` through an env `DECISION_GATE_ACT_BACKEND_<PURPOSE>` (the patience plan's
`DECISION_GATE_ACT_BACKEND_AUTO_ROUTE` pattern, executive summary item 9) with a `backend_pin_mismatch` outcome note.
**That env was never built** (zero matches in `backend/src` as of 2026-09-26). The shipped design carries the pin in the
readiness STAMP instead: every decision / outcome row records `meta.backendSpec`, the readiness job groups by it and
stamps each purpose on its CONFIGURED primary (`stamp.backendSpec`), and E12 admission refuses `act` when the stamp's
`backendSpec` is not the purpose's effective primary — so a primary change makes the purpose behave as shadow by
construction until the job re-stamps the new backend, with no deploy and no env. Fitted thresholds still never carry
across backends (jaggedness #8: "don't carry a threshold tuned on a Noul over to a Choice" applies with more force across
models).

### 7.1 The 2026-09-26 wave — per-purpose backends, challengers, open-weight systemone support

Owner ask (2026-09-26): "support the open weight version of jev for testing different decision models … we are self
hosting laya now … what changes to the backend and UI endpoint settings page?" Built as one wave of three branches
(plan: `scratchpad/jev-openweight/plan.md`; AGENTS.md bullet "2026-09-26 decision gate — per-purpose backends +
challengers + Laya/open-weight systemone support"). **Landing status: INTEGRATED** — items C, D (PUT half) and F
(branch `dg-backends/challengers`), items A, B, D (stamp/admission half) and E (branch `dg-backends/core`) and item G
(branch `dg-backends/ui`) were merged on `dg-backends/integration` (2026-09-26) with a semantic resolution of
`decision-gate.ts`; the merge wired the cross-branch seams (readiness stamp follows the configured primary in the
worker; admission refuses act on a stamp measured on another backend; one `backendSpec` field on every row;
challengers use the per-(backend, purpose) temperature + calibration rule). Every switch below answers
`grep -rn <name> backend/src`. The autofit is OPT-IN (`DECISION_GATE_TEMP_AUTOFIT_ENABLED=1`; `_DISABLED=1` kills it):

- **What "open weight Jev" is.** TypeSafe publishes no official weights; the community rebuilds — `openjev/openjev`
  (CC BY-NC 4.0, testing only), `alibiserikbay/JevK5` (Apache-2.0, `jevk5-serve` :8090, server-side calibration
  temperature), `TokenRhythm/NeoHorse-Jev-4B` (Apache-2.0, `neohorse-decision serve` :8080, no `/v1/models`) — and
  Laya (Convai, Apache-2.0, `laya-serve` :8000; 512-token context; score answers as a `distribution` LIST; noul
  `criteria` keys required; no `model` in the response; over-confident until refit) all speak `POST /v1/systemone`, so
  each is a registry endpoint of shape `systemone`. Registration recipe: `docs/SELF_HOST.md` → "Self-hosting an
  open-weight decision model".
- **A. systemone adapter tolerance + per-backend calibration:** array / `distribution` score probabilities, noul from
  `probabilities.{yes|true}`, missing `model` tolerated; absent noul criteria filled for registry servers
  (`DECISION_GATE_SYSTEMONE_NOUL_CRITERIA_DISABLED=1`); endpoint model fields `calibrated` (admin assertion) and
  `maxStateChars` (state truncation, `meta.stateTruncated`); calibrated = `jev` ∨ `reg.calibrated` ∨ a fitted
  temperature per (backend, purpose) — the readiness job writes READY fits into the backends row
  (`DECISION_GATE_TEMP_AUTOFIT_DISABLED=1`); systemone rows now persist per-question probabilities so Laya / JevK5
  can be recalibrated on Digby's labels.
- **B. Backend identity:** `meta.backendSpec` on decision, challenger and outcome rows and in the stash; readiness
  grouping by spec, not label.
- **C. Per-purpose primary + challengers** (`platform/decision-gate-backends.ts`, store row
  `['instance','decision-gate']/backends` = `{ purposes: { <p>: { primary?, challengers? } }, defaultChallengers?,
  temps? }`): the chain becomes `[primary] + seat + fallback + jev + deepseek`
  (`DECISION_GATE_PURPOSE_BACKENDS_DISABLED=1`); challengers start at t0 in parallel, never on memo hits / probes /
  pinned-spec asks, ≤ `DECISION_GATE_CHALLENGER_MAX` (2), waited ≤ `DECISION_GATE_CHALLENGER_GRACE_MS` (400) after the
  primary answers, each with its OWN decision row `{ id: <id>~c<n>, challenger:true, primaryId, backendSpec, mode:
  'shadow' }` and its own outcome row; they never touch answers / backend / mode, are never memoised and never feed
  auto-demote (`DECISION_GATE_CHALLENGERS_DISABLED=1`).
- **D. Pin + promotion:** stamp on the configured primary with `backendSpec`; admission refuses on mismatch; a PUT
  that changes an act purpose's primary writes `modes[p]='shadow'`, resets the act-band window and records
  `decision_gate_backend_changed {purpose, from, to, demotedToShadow}`; "Promote" = `{ primary: spec, challengers:
  (old − spec) ∪ [old primary] }`.
- **E. Comparison metrics:** `calls`, `failRate`, `p50Ms`, `p95Ms` per (purpose, backendSpec) beside n / accuracy /
  Brier / ECE / AUROC / coverage@5 / act band; one `decision_gate_readiness` row per (purpose, backendSpec) with `role`.
- **F. REST:** `GET/PUT /admin/model-roles/decision-backends` → `{ config, candidates:[{spec, kind, label, calibrated,
  servable, unservableReason?}], purposes }`; Test = the existing `POST /admin/model-roles/test { role:'decision',
  model: spec }`.
- **G. UI + docs (this addendum's wave):** Model roles → Decision gate → "Decision backends per purpose" panel
  (primary select · challenger chips · Test per backend · comparison table · "Promote to primary" with the confirm
  copy "act drops to shadow until the readiness job re-stamps this backend (≤6 h)"); the Decision gate seat picker
  offers every registry model (it used to hide non-[coding] ones); the Endpoints dialog's [calibrated] chip + "max
  state chars" field and its systemone copy naming Laya / openjev / JevK5 / NeoHorse; `.env.example`,
  `docs/SELF_HOST.md`, `listFixedChains` decision_chain, AGENTS.md, memory-bank.
- **Rollout:** A+B first (no behaviour change) → owner registers Laya / JevK5 (+ openjev for non-commercial tests)
  and Tests them → C–G → challengers on the background purposes first (wake_triage, sweep_triage, drain_triage — ≥ 2 s
  budgets) → after ≥ 3 days compare on the panel → promote per purpose (act drops to shadow, the 6 h job re-stamps,
  re-flip through the existing admission path). §6's "How to validate" bars are unchanged.

## 8. Owner decisions

1. **Machine-wake reasoning effort (N9).** The largest lever found (order $30–60/day, up to ~50 h/day of aggregate
   thinking across 631 supervisor machine turns) conflicts with your 2026-09-22 directive that machine wakes keep `max`.
   Options: keep `max` (status quo); allow a gate-scored downgrade to `high` only for non-alarm wakes at q ≥ 0.9; or
   set machine wakes to `high` outright and skip the gate. Not built without a ruling.
2. **wake_triage act semantics.** As built, act = a 30-min park that then delivers unconditionally (delay, not
   removal). Alternatives: (a) keep the bounded park and measure the coalescence share first; (b) route a confidently
   no-action batch into the supervisor's board digest (the 2026-09-16 board injection) with no wake at all —
   deterministic removal, no delay-then-deliver; (c) chained re-triage on re-delivery (rejected by one lens as breaking
   the WI-R "nothing is lost" guarantee). Recommendation: (b), in shadow first.
3. **self_audit: re-pose or retire.** Either fund E8 (receipt substance, per-step nouls, composite label; medium risk
   because a false "evidenced" skips a safety pass) or accept that "is the work actually done" is outside the envelope
   and stop paying ~250 Jev calls/day for it. Recommendation: E5 label fix first, then one week of shadow, then decide.
4. **Sequencing against the patience program.** `auto_route` is your mandated next act-mode purpose and it needs the
   same E1 tooling, the same label pipeline and (for replay) the E14 corpus. Proposed order: E1/E2/E3/E4 → patience
   Phase 0/1a → label fixes (E5) → E7 → N1/N2 as new shadow purposes → everything else.
5. **Replay-corpus egress and consent.** E14 stores redacted state snapshots; for purposes whose state is user text
   (imessage_send, memory_extract, auto_route) this is the same question as the patience plan's Q1 (label-window
   egress for non-Auto users). Purposes without user text can start now.
6. **Open-weights host.** GPU spend (RunPod/Brev class) vs CPU on box C (already saturated) vs wait until E1 exists to
   compare against. Recommendation: wait for E1, then a CPU JevK5-GGUF shadow leg for the three background purposes.
7. **Human adjudication sample (E15).** ~80 items once (50 wakes, 30 self-audit finals). Who does it, and is it worth
   your time versus a lane doing it with the strike-adjudication machinery?
8. **Flip authority.** Today any admin can PUT `act` on any purpose with zero labels. Confirm E12's admission control
   (report-stamped READY + auto-demotion) as the rule, and whether the Fleet Supervisor may ever flip a purpose itself
   (recommendation: no — flips stay a human PUT).

## Sources

Paper: arXiv 2609.26550v1 (HTML, saved as `scratchpad/dm-jevpaper/paper.txt`, §1–§8, Limitations, Ethics, App. A–L).
Vendor pages the paper cites: docs.typesafe.ai `/api`, `/confidence`, `/model-jaggedness/jev-1.13`, `/models`; plus
`/concepts/state`, `/concepts/system-one`, `/concepts/how-to-build-with-system-one`, `/primitives`, `/primitives/noul`,
`/primitives/advanced`, `/patterns/fan-out`, `/patterns/confidence-routing`, cookbooks (`sde_cascade`,
`parallel_questions`, `llm_guardrails`, `function_calling`, `classification_using_confidence`), `/agent-skill`,
`/introduction/coding-agents`, the ML primer, and the GitHub SKILL.md. Repo: `platform/decision-gate.ts`,
`decision-gate-modes.ts`, `decision-gate-math.ts`, `decision-gate-fit.ts`, `decision-outcome-labels.ts`,
`coding/self-audit-gate.ts`, `platform/auto-router-gate.ts`, the seven consumer sites, `AGENTS.md:1571` and
`:2151-2167`, `.env.example:894-928`, `docs/PATIENCE_AUTO_ONLY_DEPRECATION_PLAN_2026-09-25.md`. Prod: read-only SQL over
`loop_metrics` (`decision_gate`, `run_spend`, `memory_extraction`, `guard_strike`, `schedule_*`, `wake_*`,
`crosscheck_*`), `crossmodel_messages`, `agent_runs`, `hook_events`; raw outputs under the session scratchpad
(`dm-jevpaper/`, `dm-fable/`, `dm-savings/q1…q23`, `dm-sweep/volumes.txt`, `dm-synth/q-snapshot.txt`,
`dm-synth/q-actband.txt`). Hugging Face API for the open-weights model cards (existence, licence, serving claims).
