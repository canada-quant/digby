# Trajectory evals — frozen real incidents, graded on outcomes

The safety net for retiring guards, shadow purposes and doctrine rows one at a
time (simplify.md step 3, build 2026-10-08 E). Each **case** is one real
incident frozen as replayable input; the suite runs it through the **real agent
loop** (`coding/agent.ts runCodingAgent`, the role's real profile, today's
doctrine) with every mutating tool **captured, never executed**, and grades what
the run **delivered** — the final text and the captured side effects. Graders
check outcomes ("a claimed send has a send", "every id was seen", "a dismissed
question is not re-raised"), never the path (which reads, in what order).

## Run it

| command | what | cost |
|---|---|---|
| `npm run eval:trajectory` | offline replay of every recording (also part of the normal `jest` run in CI) | free |
| `npm run eval:trajectory -- -t <case-id>` | one case | free |
| `EVAL_CASES=<a,b> npm run eval:trajectory:live` | k live trials per case on the real seats, pass^k, report + recordings in `EVAL_REPORT_DIR` (default `./eval-out`) | real money, capped by `EVAL_MAX_USD` ($10 locally; the nightly workflow passes $25) |
| `npm run eval:trajectory:calibrate [-- --regen]` | judge agreement with the owner's labels / rebuild `judge-labels.json` | free |
| `npm run eval:trajectory:new -- <case-id>` | scaffold a hand-built case | free |

Nightly + on demand: `.github/workflows/trajectory-evals.yml` (inputs: `k`, `max_usd`,
`cases`, `seats`, `model`, `effort`, `judge_model`, `judge_labels`; off with the repo
variable `TRAJECTORY_EVALS_DISABLED=1`).

Live options (runner config, not product switches): `EVAL_K` (3), `EVAL_MAX_USD` (10),
`EVAL_CONCURRENCY` (4), `EVAL_TRIAL_TIMEOUT_MS` (15 min), `EVAL_EFFORT` (`high` | `max`),
`EVAL_MODEL` (one model for every case), `EVAL_SEATS` (`fleet_supervisor=glm-5.3,chat=…`),
`EVAL_GATEWAY_BASE_URL` + `EVAL_GATEWAY_API_KEY` (run `<label>:<model>` seats on the
gateway; without them a gateway seat runs on its family built-in), `EVAL_JUDGE_MODEL`
(`deepseek-flash`; `off`), `EVAL_JUDGE_LABELS=1` (also judge the calibration items),
`EVAL_CASES` (`none` = labels only), `EVAL_REPORT_DIR`.

## A new incident becomes a case in one step

```bash
bash /opt/crossmodel/scripts/framework-audit/prodq.sh freeze-trajectory-case.js <assistantMessageId> --id <case-id> --tz America/Los_Angeles \
  > backend/src/modules/crossmodel/evals/trajectory/cases/<case-id>.json
```

The read-only freeze writes a complete **draft**: the triggering message and the
rows before it as `input`, every tool call the incident made as a `fixture` (its
stored result as the output), the run itself as the `incident` recording, and
default graders (ids grounded, call ids grounded, one `claim_requires_call` per
first-person action verb in the answer). Then, in the same PR: tighten the graders
to the incident's own failure, add a `reference` recording (what a correct run
does — it must pass), set `status: "active"`, and run `npm run eval:trajectory -- -t <case-id>`.
For an incident known only from a ledger row, `npm run eval:trajectory:new -- <case-id>`
writes the same skeleton by hand; a half-filled case fails CI until its incident fails
the graders and its reference passes them.

## How a case is graded

- **Offline (CI):** every recording must still get its declared grade —
  `incident` → fail (the graders catch it), `reference` → pass (they accept valid
  work). A `focus: "harness"` case's incident must PASS (today's harness repairs
  it; delete the fix and the replay breaks). A replay that **diverges** — today's
  harness asks the model for something the recording never answered (a new
  retry round, a different seat) — fails with a re-record hint. Inside a replay
  every network call is refused. Harness *protocol* side calls whose output is
  never delivered nor executed (today: the typed `finish_run` shadow nudge) are
  answered by the replay itself (`eval-runtime.ts protocolSideCall`) — register a
  new one there only if it provably cannot change what the run delivers.
- **Live:** `k` trials per case; **pass^k** = every trial passes (τ-bench). Each
  live trial is saved as a recording (`eval-out/recordings/<case>.recordings.json`);
  copy one into a case to pin today's behaviour offline.
- **Baseline:** `baseline.json` lists the cases that passed pass^3 in three
  measured baseline runs, with the noise allowance seen between them. The nightly
  run fails when more than `noiseCases` of them lose pass^k (simplify.md's bar:
  pass^3 ≥ baseline − 1 case after any deletion PR).

## Graders

| kind | outcome it grades |
|---|---|
| `claim_requires_call` | a claim in the final ("I've messaged …") needs a captured call that backs it |
| `must_call` / `must_not_call` | the requested effect happened / a forbidden effect did not |
| `final_matches` / `final_not_matches` | the reply says / does not say something (`withinChars` = answer first) |
| `ids_grounded` / `call_ids_grounded` | every id in the reply / in a tool argument was seen this trial |
| `fact_grounded` | a stated fact (a model number, a quant label) appears in what the run read |
| `headline_clock` | a clock stamped at the top of the reply is the real now |
| `max_calls` / `max_model_calls` | generous cost bounds (never a path) |
| `judge` | one binary LLM rubric — **advisory** until calibrated |

**Judge calibration.** `judge-labels.json` holds 50 items (rubric + request + calls +
reply). The owner sets `ownerLabel` (`pass` / `fail`) on each; a live run with
`EVAL_JUDGE_LABELS=1` writes the judge's verdicts to `eval-out/judge-labels.judged.json`
(copy them in). Judge graders become binding once ≥ 50 items carry both labels and the
judge agrees with the owner at TPR ≥ 85 % and TNR ≥ 85 % (`npm run eval:trajectory:calibrate`).

## Files

`types.ts` schema · `fixtures.ts` the fixture tool layer · `replay-model.ts` · `graders.ts` ·
`judge.ts` + `labels.ts` · `prompt.ts` (today's doctrine, the case's frozen state) ·
`eval-runtime.ts` (per-trial AsyncLocalStorage) · `eval-mocks.testkit.ts` (the jest seams) ·
`harness.testkit.ts` (one trial) · `runner.testkit.ts` (replay / live suites) · `suite.ts`
(loading, pass^k, report, baseline) · `cases/*.json`.
