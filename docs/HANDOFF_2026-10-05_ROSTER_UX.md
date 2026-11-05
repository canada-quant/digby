# Handoff — dynamic roster, status voice, model pick (2026-10-05)

Owner (2026-10-05): "make sure the framework and fleet supervisor and crossmodel projects themselves are up to date with
all your updates and enhancements and then pass over your work that is remaining over to them to finish out".

This is the hand-off from a Claude Code session (2026-10-03 → 2026-10-05) to the **crossmodel project supervisor** and
its lanes. Every item below has a canonical bullet in `AGENTS.md` (search the 2026-10-04 bullets) — read it before
acting. Nothing here needs the owner unless it says **OWNER**.

## 1. What shipped (all merged to main and deployed)

| PR | What | Where to read |
|---|---|---|
| #1236 #1237 #1243 #1244 #1245 | Live E2E query suite (`scripts/e2e/query-suite.py`) + human-message corpus (`human_corpus.py`, ~85 realistic messages) + nightly GitHub workflow; nightly **live-chat audit** cron on real human turns (replay, judge, quality judge, regressions, briefing line) | `docs/E2E_QUERY_SUITE.md`, `platform/live-chat-audit.ts` |
| #1240 | Verifier observe-only on human chats; lead-effort A/B (`CHAT_LEAD_EFFORT_AB_SHARE`) | AGENTS.md |
| #1241 #1258 | Coding quick wins (verify-unchanged skip, reviewer diff gate, machine-firing effort step-down); `run_tool_profile` WRITE counters (`codeWrites` / `gitWrites` / `platformWrites`) — the label for coding option D | `docs/CODING_DYNAMIC_ROSTER_OPTIONS_2026-10-04.md` |
| #1245 #1259 | Durable act-band auto-demote (readiness job); tier-2 shadow→act autonomy; `wake_triage` act CONTROL SAMPLE (1 in 10 confident parks fires) | `platform/decision-gate-durable-demote.ts`, `docs/DECISION_GATE_ROLLOUT_PLAYBOOK.md` |
| #1260 #1262 #1267 | **Thinking never reaches a client** (`coding/reasoning-wire.ts`); **Digby status voice** (`chat-agent/status-voice.ts`, rules in its header); pulse names what Digby is doing; second-opinion wording | AGENTS.md "Thinking stays on the server" |
| #1261 #1263 | Google tag site-wide (`AW-11419212138` + `AW-16512038948`) + Sign-up conversion; never for Digby Kids; Ad Manager library off for kids | `frontend/lib/google-ads.ts` |
| #1265 | **Per-turn MODEL PICK** (shadow): the decision chooses the lead model per standard / checked turn from every open, servable model; pinned chats never swap; `PUT /chats/:id` keeps leadModel with a rename | `platform/model-pick.ts`, `platform/model-evidence.ts` |
| #1266 | Offline **model benchmark** → scorecard (`scripts/e2e/model-bench.py` → `scripts/framework-audit/model-bench-ingest.js`) | `docs/MODEL_BENCH.md` |

Live-verified on prod: 0 reasoning events on the wire (was ≈1,000 per answer), the new status lines, the Google tag on
`/` + `/login` (and absent for a child token), `metadata.depth.turnPlan.modelPick` recorded in shadow.

## 2. Facts the next session needs

- **Real users wait too long.** 7 d, 4 real users: first word p50 83 s, p90 418 s, **41 % of human turns > 2 min**. The
  median turn makes 0 web calls — the wait is the lead model, not research.
- **The seat's route is the bottleneck.** Benchmark `mb1005b` (8 models × 10 questions, real pipeline, test account):
  first word p50 — built-in `glm-5.3` 11 s (p90 14), gateway `cql-litellm:api-deepseek-v4-pro` 11 s (25), `kimi-k3` 22,
  `deepseek-flash` 27, gateway `…qwen3.8-flash` 27, `qwen3.6-27b` 33, gateway `…qwen3.8-max` 42 (185), **today's Digby
  seat `cql-litellm:api-optimize-zai-glm-5.3-flash` 42 s (p90 104)**. Split by effort arm the seat is slow at BOTH
  `high` (11–104 s) and `max` (27–222 s) while built-in GLM-5.3 is a steady 9–14 s ⇒ it is that gateway ROUTE
  (`api-optimize-zai-…`), not the model or the effort.
- **Shadow model-pick readout** (MBR1005): standard turns → `deepseek-flash` (~8 s vs seat ~34 s); checked → gateway
  `deepseek-v4-pro` (~11 s vs ~52 s); checked + high stakes → seat stays (gain under margin).
- **The quality judge does not discriminate yet**: almost every answer scored 5/5 (all models 4.5–4.6) ⇒ today's picks
  are effectively "fastest wins". The judge is the Utility seat (gateway qwen3.8-flash) — qwen candidates may self-prefer.

## 3. Remaining work — in priority order

### P1 — make the model-pick evidence trustworthy, then recommend the flip (crossmodel repo lane)
1. **Exclude synthetic turns from prod evidence.** `platform/model-evidence.ts` counts the bench / suite turns of the
   test account (`claudebot@digby.ai`) as "prod" latency (double counting — some models show n 8–9 where the bench has
   fewer). Stamp `synthetic: true` on the `ux_ttft` row when the run's user is the test account (chat-agent.service.ts,
   the `ux_ttft` recordLoopMetric) and filter it in the evidence SQL; ALSO exclude rows whose chat belongs to the test
   account (old unflagged rows — keep bench chats ≥ 14 days, then `model-bench.py --cleanup-run <id>`).
2. **Small lane buckets fall back to the model's overall numbers.** In `mergeEvidence`, use `lanes[lane]` only when its
   `n ≥ MIN_EVIDENCE_N` (5), else `lanes.all` (checked had n = 1 per model).
3. **A discriminating judge.** Replace / supplement the absolute 1–5 rubric in `model-bench-ingest.js` with a BLIND
   per-question comparative judge: all candidates' answers to the same question, anonymised + shuffled, ranked (or
   scored relative to each other); store the relative score as `quality`. Use a judge whose family is not a candidate's
   where possible (or average two judges). Pin it with tests (`model-bench-scorecard.test.ts`).
4. **A bigger bench.** ~30 questions so every lane bucket has ≥ 5: `model-bench.py --n 30 --drop-refused` over the 8
   models of `mb1005b` (built-in `glm-5.3-flash` is not a lead pick — refused, expected). Then ingest (detached:
   `systemd-run`, see the MBI1005 one-shot on branch `audit/turn-plan-canary`) and re-run the MBR readout.
5. **DONE — the owner flipped the pick to ACT on 2026-10-05** ("yes switch the model pick on"; one-shot MPA1005). P1
   items 1–4 are now evidence QUALITY work on a live feature: land them, re-run the readout, and report to the owner
   only if a pick looks wrong (quality drop, fallback spike) — rollback `set-model-pick-mode.js --apply shadow`.

### P2 — gateway route latency (CQL LiteLLM Gateway project)
The `api-optimize-zai-glm-5.3-flash` route is 4× slower and erratic vs Z.AI direct and vs the gateway's own DeepSeek
v4-pro. Find out why (cooldowns / quota windows / queueing on that provider group — earlier history: 403 weekly-limit
storms on `api-optimize` groups) and fix or report. Until fixed, the model pick routes around it once it acts.

### P3 — turn_plan label hygiene (crossmodel)
The query suite TAPS Dig-deeper on purpose (category `dig`), which labels a Quick-lane act "wrong" (`escalated`). The
`turn_plan` act band had 1 / 5 agreed at the 2026-10-04 read; the provenance probe (TPL1004 on `audit/turn-plan-canary`)
ran but its output was not captured — re-run it under a NEW marker (which sessions / users produced the act-band labels,
and whether they are the test account) before changing anything. Exclude the test account's labels from fit / auto-demote (stamp synthetic on the turn plan, or
`excludeFromFit` in `chat-agent/turn-plan-labels.ts`), else 30 such labels demote the Quick lane fleet-wide.

### P4 — watch the decision-gate changes (crossmodel)
- `wake_triage` control sample (#1259): once ≥ 30 act-band control labels exist, the durable demote judges it (bar 0.9).
- Lead-effort A/B: the nightly live-chat audit's `effortArms` — at the 2026-10-04 read the `high` arm was not faster
  (arms are clustered by unit — read per user before concluding). The model pick may make the A/B moot for the seat.
- The nightly `live-chat-audit` (04:08Z) + `nightly-query-suite` (10:17Z) — read each morning; regressions file tickets.

### P5 — coding option D step 2 (crossmodel)
After a few days of `run_tool_profile` write counters: a SHADOW firing-effort predictor for schedule / hook firings
(label = `runDidWrite`; state = the lane's last 5 profiles). See `docs/CODING_DYNAMIC_ROSTER_OPTIONS_2026-10-04.md` §D.

### P6 — smaller follow-ups (crossmodel)
- The model catalog lists `agx-embed` / `agx-rerank` as CHAT models (`model-endpoints/model-catalog.ts`) — the picker
  filters them, the catalog should too.
- A `<think>` block that starts MID-answer still streams (only a leading one is routed) — the live-chat audit counts
  `ANSWER_LEAK_RE`; fix if it shows up.
- `utility-llm.ts` returns reasoning on an empty reply for callers without `contentOnly` (KB URL overview, coding
  session summary) — set `contentOnly` where the text is user-visible.
- Older `NEXT_PUBLIC_*` kill switches (e.g. `NEXT_PUBLIC_DEPTH_UX_DISABLED`) are not forwarded into the frontend build
  (`docker-compose.app.yml` → `frontend/Dockerfile`) — setting them does nothing until wired like
  `NEXT_PUBLIC_HIDE_REASONING_DISABLED`.
- Status voice polish: the pulse and the "thinking" line can land in the same second; the browser agent's one-line
  "why" reasoning still shows as an action label (owner call — leave unless asked).

### OWNER items (not for lanes)
- ~~Flip the model pick to act~~ — done 2026-10-05.
- The owner declined the Google-tag consent / privacy follow-up and the Xiaomi key rotation reminder ("dont worry about
  that") — not open items.

## 4. Answered owner question
- `oq_6e9d1626` (box-C one-shot cleanup re-decision) — answered 2026-10-05 on the owner's instruction: **call it moot**,
  record in the ledger, no more re-census cadence; keep the standing sweep + 90d cold-archive automation.
