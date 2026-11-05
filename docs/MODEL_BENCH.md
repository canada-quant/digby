# Offline model bench — per-model scorecard for the lead picker (runbook)

Added 2026-10-04 (dynamic roster). The decision model will pick ANY open model per task instead of the fixed
"Digby" lead seat. The owner's rule: **no live exploration on real users** — so every candidate is measured
OFFLINE, on the canonical prod **test account only** (`claudebot@digby.ai`, AGENTS.md "Canonical prod test
account"; never register accounts, never use another one), by replaying the same realistic questions through the
REAL production chat pipeline with the per-chat lead override. Three pieces:

| Piece | Where it runs | What it does |
|---|---|---|
| `scripts/e2e/model-bench.py` | your machine / a session (stdlib Python) | runs the bench: one chat per (question, model), the lead pinned with `PUT /crossmodel/chats/:id {leadModel}`, the question streamed with the query suite's own client; JSONL + markdown summary |
| `scripts/framework-audit/model-bench-ingest.js` | inside the live backend container (`prodq.sh`) | reads the run's chats, ranks the answers to each question BLIND + COMPARATIVELY, aggregates, MERGES the scorecard into the context store |
| `backend/src/modules/crossmodel/platform/model-bench-scorecard.ts` | the backend | the pure aggregation (`aggregateBenchRows`, `mergeScorecards`, attribution, title parsing — per lane and per task kind) + `readModelBenchScorecard()` — what the picker imports |

> **It costs real money.** N questions × M models real model runs (a question the turn plan routes to research
> can run a council). CI runs only the offline checks (`scripts/e2e/model-bench.test.sh`,
> `scripts/framework-audit/model-bench-ingest.test.sh`, the jest suites). Never schedule the live bench without
> the owner's go-ahead.

## Run it

```bash
# Free: the plan (questions, model order per question), the self-test
python3 scripts/e2e/model-bench.py --dry-run --models glm-5.3,deepseek-flash,cql-litellm:api-optimize-alibaba-qwen3.8-flash --n 12 --seed 7
python3 scripts/e2e/model-bench.py --self-test

# 1. Bench (prod, the test account — credentials from AGENTS.md, never committed)
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py \
  --models glm-5.3,deepseek-flash,cql-litellm:api-optimize-alibaba-qwen3.8-flash \
  --n 12 --seed 7 --run-id mb1004a          # → model-bench-mb1004a.jsonl + model-bench-mb1004a.md; chats KEPT

# 2. Ingest — dry run, then write (box A; prodq.sh does NOT forward env vars, so pass flags). A judge-v2 ingest runs
#    1–2 h: use prodq-detached.sh (same args) — prodq.sh's docker exec dies with the backend on the next deploy.
bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mb1004a
bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mb1004a --apply
#    optional in the same pass: --cleanup (needs --apply) deletes the run's chats after the write

# 3. Cleanup (if not done by the ingest)
DIGBY_E2E_EMAIL=... DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py --cleanup-run mb1004a [--dry-run]
```

From a session without SSH, the ingest goes through an ec2-ops one-shot (`docs/REMOTE_OPS.md`).
⚠ STALE (2026-10-12): the `scripts/framework-audit/run-on-box.sh A '<the prodq line>'` path relied on the
owner's admin AWS key, which is DELETED — use it only once a scoped role exists. A large run's judge pass takes minutes (≤ 90 s per answer, 4 at a time) — run it
detached (`systemd-run --collect …`) when it would outlive the SSM window.

**Bench options:** `--n` questions (each runs on every model), `--seed`, `--run-id` (default `mb<UTC timestamp>`;
letters / digits / `. _ -`), `--groups lookup,howto,…` (human-corpus groups), `--lanes quick,standard,checked,tools`
(question families aimed at a lane), `--kinds writing,code,…` and `--per-kind K` (task kinds — see **Task kinds**
below), `--question-set corpus|tools|mixed|kinds`, `--concurrency 2` (≤ 4), `--case-timeout 900`, `--settle 300`,
`--out` / `--report` (default `model-bench-<runId>.{jsonl,md}`), `--drop-refused` (continue without a spec the
server refuses; default: exit 2 before any stream).
**Ingest flags:** `--run-id` (required), `--apply`, `--cleanup` (needs `--apply`), `--no-judge`,
`--judge-model <spec>` (P1.5: pin the blind comparative judge to ONE model — a built-in id or an enabled
instance-wide `<label>:<modelId>` registry spec; without it, a Utility seat that shares a family with a bench
candidate AUTO-PICKS a conflict-free servable judge from the model catalog, open/non-frontier preferred),
`--judge-concurrency N` (≤ 8), `--verbose` (backend logs on), `--unattended` / `--attended` (28d9e351). Env twins
for `docker exec -e` / local runs: `RUN_ID`, `APPLY=1`, `CLEANUP=1`, `NO_JUDGE=1`, `JUDGE_CONCURRENCY`,
`JUDGE_MODEL`, `UNATTENDED=1|0`.

**Unattended fail-safe (28d9e351).** An UNATTENDED invocation — no tty on stdin (the `prodq.sh` `docker exec`
shape, `systemd-run` transients, CI) or systemd's `INVOCATION_ID`/`MANAGED_BY=systemd` environment — behaves
differently, because no human is reading the ⚠ fallback warnings (the mb-open-b2-20261006 contamination: an
auto-picked judge route the gateway had retired 400'd on every call, and 95 absolute-scale rows landed on the
comparative scorecard silently):

- without `--judge-model` the ingest PINS the comparative judge to the default
  `qwen3.6-27b` (since 2026-10-20; `cql-litellm:spark-mimo-v26-flash-rl` before — that gateway route left the catalog) (conflict-free with the usual bench families) instead of the
  family-conflict auto-pick — pass `--judge-model <spec>` to override. The pinned default is NOT itself
  servability-checked: if that route is ever retired at the gateway, every unattended ingest refuses (exit 1)
  until the constant is re-pinned — deliberate fail-loud, never a silent absolute fallback;
- if the judging pass would write ANY absolute-scale row (family-guard fallback, a failed comparative call) or
  lose ANY judge call, the ingest REFUSES: exit 1, a terminal `{"error":…}` naming 28d9e351, and NOTHING is
  written — no scorecard merge, no `--cleanup` deletion. Fix the judge route and re-run. A SINGLETON question
  (only one model measured — the others failed, failed over or were diverted) no longer trips this (2026-10-20):
  it is left UNJUDGED instead (see **The judge**), so one failing model cannot sink an unattended run;
- but an **ALL-singleton** run — answers were measured yet NO question had two measured models (0 comparative
  groups, every measured answer a singleton: a model failed / failed over / was diverted on every question, or a
  two-model run lost one model) — is a broken run, not a refresh: an unattended ingest REFUSES it (exit 1, nothing
  written, 2026-10-20 review); an attended run writes it with a ⚠ line. A MIXED run (≥ 1 comparative group beside
  its singletons) is a normal run and writes;
- the judgeless escape stays open: `--no-judge` (or `NO_JUDGE=1`) unattended writes no quality and never refuses;
- an attended run (a tty, or `--attended` / `UNATTENDED=0`) keeps the disclosed ⚠ + absolute fallback as before.

The auto-pick itself also hard-skips unservable/retired catalog routes at the script level (`servable !== true`
never wins, belt under the registry's `unservable` flag), so a listed-but-retired route can never be chosen
even on a box that predates the flag's deploy.

### From GitHub Actions (roster 2026-10-06 C-2)

`.github/workflows/model-bench.yml` (workflow_dispatch only) runs `scripts/e2e/model-bench.py` as the canonical test
account (`DIGBY_E2E_EMAIL` / `_PASSWORD` secrets) and then the ingest `--apply` DETACHED on box A, polling for its
`RESULT` line. Inputs: `models` (comma list, ~8 per run), `n` (default 12), `question_set` (`corpus` | `tools` | `mixed` |
`kinds` — `tools` = 18 tool-using questions so the bench measures the web calls real turns make), `lanes`
(`quick,standard,checked,tools`), `kinds` + `per_kind` (task kinds, 2026-10-20 — `per_kind` 1..20 replaces `n`; the
plan step refuses `per_kind` with `lanes` / `groups` and any plan over the 300-min pacing budget: streams = models ×
(`n`, or `per_kind` × the kinds, all seven when `kinds` is blank)), and `judge_model` — the comparative judge spec, **pinned by default to
`qwen3.6-27b` (since 2026-10-20; `cql-litellm:spark-mimo-v26-flash-rl` before — that gateway route left the catalog)** (2026-10-06: the mb-open-b2-20261006 run ingested without a pin, the
family-conflict auto-pick chose the then-listed but gateway-torn-down `api-cohere-command-a-plus` route, and every judge
call 400ed — 95 absolute-scale rows landed before a re-score; a blank value restores the auto-pick). Example:
`gh workflow run model-bench.yml -f models=<list> -f n=12 -f question_set=mixed`; a kind run:
`gh workflow run model-bench.yml -f models=glm-5.3,deepseek-flash,kimi-k3 -f kinds=writing,code,analysis,planning -f per_kind=10 -f run_id=mbk1020a`
(120 streams ≈ 50 min pacing floor), then `-f kinds=lookup,advice,explain -f run_id=mbk1020b`.
Price frontier models first (Admin → Endpoints $/M in + out) — an unpriced frontier model is costed at $15 / $75 per M
by the pick's κ·USD term (`platform/roster-policy.ts`). The ingest's judge-family guard covers claude / gpt / grok /
gemini, so a frontier spec is never judged by its own family.

## How the bench is fair

- **Same text for every model.** Questions come from `scripts/e2e/human_corpus.py` `CORPUS` (plus the bench-only
  `TOOL_CORPUS` / `KIND_CORPUS` when the question set includes them), filled once with the seeded rng and **never
  noised** (no casual prefix, typo or case change); entries flagged `vague` are always skipped, entries flagged
  `code` unless the run asks for the `code` kind. The sample is **stratified**: one question per corpus group per
  round, group order seeded (`--per-kind`: stratified within each kind, interleaved across kinds).
- **Interleaved and rotated.** Every model answers q1, then q2, … and the model ORDER rotates one step per question,
  so time-of-day drift, provider load and "who ran first" hit every model equally.
- **Paced.** The suite's `Pacer` keeps ≤ 20 stream starts per rolling 10 minutes (the limiter is 25 / 10 min / IP —
  do not run the query suite from the same IP at the same time).
- **A preflight** pins each spec once on a throwaway chat (deleted at once): a refused spec stops the run before any
  money is spent; an aliased spec (`glm-5.2` → `glm-5.3`) is benchmarked under the canonical id the server stored.
  The per-chat override accepts a built-in the Digby seat offers or an enabled, chat-capable, INSTANCE-WIDE
  `<label>:<modelId>` registry model (`chat-agent/chat-lead-model.ts resolveChatLeadPick`).

## Attribution — what a row measures

The answer row's `metadata.models.digby.modelUsed` says who ACTUALLY led. The bench and the ingest share one rule
(`attribute()` in the bench, `attributeBenchRow()` in the leaf):

| Attribution | When | Counts for the spec |
|---|---|---|
| `measured` | `modelUsed === spec`, a non-empty answer, no lead error | n, latency, quality, fail rate (as a success) |
| `failed` | no answer row, an empty answer, or a lead error | n, fail rate (as a failure) |
| `failover` | another model finished the turn (the seat fallback) | n, fail rate (as a failure) — never latency / quality |
| `diverted` | the Quick lane ran the turn (`depth.plan.lane === 'quick'`) on another model | **excluded** |
| `unverified` | an answer with no recorded leader | excluded |
| `refused` / `harness` | the lead pick was refused / the chat could not be set up — never sent | excluded (bench only) |

**Pinned chats never take the Quick lane (since 2026-10-04).** A chat pinned to a lead model
(`crossmodel_chats.leadModel` — exactly what the bench sets) never takes an automatic swap: neither the Quick lane
nor the per-turn model pick (`chat-agent.service.ts chatLeadPinned`). So `diverted` is effectively historical — a
quick-classified question is answered by the pinned spec, and a bucket stamped lane `quick` measures that spec
OUTSIDE the Quick lane's thin profile (web budget, thinking off). What a pin does NOT hold is DEPTH: the turn plan
still runs, and the lane-depth rules (checker / no checker) apply to a pinned chat like any other — bench rows
describe whatever depth regime the test account has when the run happens.

## The store contract (what the picker reads)

ONE context-store row: namespace `['instance','model-bench']`, key `'scorecard'` (`MODEL_BENCH_STORE_NS` /
`MODEL_BENCH_STORE_KEY`):

```json
{ "updatedAt": "ISO", "updatedBy": "model-bench-ingest", "runs": ["mb1004a", "…"],
  "models": { "<spec>": {
      "lanes": { "<lane>": {
        "n": 12, "ttftP50Ms": 5200, "ttftP90Ms": 14100, "doneP50Ms": 31000, "failRate": 0.0833,
        "quality": 4.1, "qualityN": 10, "webToolsMean": 0.8, "runId": "mb1004a", "at": "ISO" } },
      "kinds": { "<kind>": { "...the lane stats...": "", "fieldSize": 3 } } } } }
```

- `<lane>` = the turn-plan lane the question's answer recorded (`quick` / `standard` / `checked` / `research`,
  `none` when no turn plan ran) plus `all`.
- `ttftP50Ms` / `ttftP90Ms` / `doneP50Ms`: server-side `metadata.ux.ttftMs` / `completionMs` over MEASURED rows
  (nearest-rank, the live-chat audit's rule); `null` when none. `failRate` = (failed + failover) / n.
- `quality`: mean 1..5 quality over judged measured rows — a comparative RANK mapped onto 1..5 (see **The judge**);
  `qualityN` how many were judged. `webToolsMean`: the lead's mean web tool calls per measured answer (absent on
  buckets ingested before the count existed).
- `kinds` (2026-10-20): the same stats per TASK KIND (`writing` / `code` / `analysis` / `lookup` / `advice` /
  `planning` / `explain` — `platform/task-kind.ts` `TASK_KINDS`), plus `fieldSize` = how many specs were MEASURED on
  that kind in the run (rank quality is only comparable within one field). ABSENT on a spec with no kind rows.
- `at` = the newest answer in the bucket (when it was measured). **Merge rule** (`mergeScorecards`, per bucket):
  1. a newer run REPLACES the same spec + lane bucket and the same spec + kind bucket; a re-ingest of an OLDER run
     never clobbers a newer bucket;
  2. **a THIN kind bucket never replaces a DEEP one** (2026-10-20 review): an incoming kind bucket with fewer than
     `KIND_BUCKET_KEEP_MIN_N` (8 — mirrors the picker's `BENCH_KIND_MIN_N`, pinned equal by jest) JUDGED answers
     leaves a stored bucket with ≥ 8 judged answers WHOLE — the picker could not use the thin one, and a routine
     refresh's 1–4 rows per kind used to wipe the deep bucket a paid kind run built. A thin bucket is dropped even
     from a dedicated kind run, so refresh a kind with ≥ 8 per kind. Lane buckets have no such floor: a newer small
     run still replaces a bigger lane bucket (do not follow a big run with a tiny one if you want its lane numbers);
  3. **null quality never erases judged quality** (2026-10-20 review): an incoming bucket with no judged quality
     (quality null, or `qualityN` 0 — a `--no-judge` ingest, singletons left unjudged) keeps the stored bucket's
     `quality` + `qualityN` and takes the newer `n` / latency / `failRate` / `runId` / `at` (so `runId` can name the
     newer latency run while the quality was ranked in an older one — on a kind bucket only below the keep floor,
     where the picker never reads it). Before, an all-singleton run wiped judged quality and the pick read "seat
     unmeasured" and stopped switching.

  Other specs / lanes / kinds are kept; `runs` is the union (last 100). The ingest reads the RAW row before writing
  — a store read error aborts, so a transient failure is never merged as "no row". An image older than 2026-10-20
  that ingests once DROPS every kind bucket (its normalize rebuilt `{lanes}` only); re-ingest the kind run after a
  rollback.
- `readModelBenchScorecard({fresh?})` returns the normalized row or `null` (absent / unreadable), never throws,
  cached 60 s per process.

## The judge — and its bias

**Primary: BLIND COMPARATIVE ranking (P1.3, 2026-10-06).** The measured answers to ONE question are grouped,
anonymized to labels A/B/C… in a seeded-shuffled order (the judge never sees a model identity or a fixed position)
and ranked best-first in ONE call — `live-chat-audit.ts comparativeJudgeOnModel` on the `--judge-model` spec
(pinned by default on unattended runs to `qwen3.6-27b` (since 2026-10-20; `cql-litellm:spark-mimo-v26-flash-rl` before — that gateway route left the catalog)), else `defaultComparativeJudge` on
the Utility seat, both with `COMPARATIVE_RUBRIC`. Rank 1..K maps onto 1..5 (`rankToQuality`: K=2 → 5/1, K=3 →
5/3/1, K=4 → 5/4/2/1), so **quality is relative to the field benched together** — compare buckets from the same
run (a kind bucket's `fieldSize` says how big its field was).

**Singletons are unjudged (2026-10-20).** A question only ONE model answered has no rank; it keeps quality null
(still counted in n / latency / failRate) and the ingest prints `singletons unjudged: N`. Before, it was
absolute-scored — a different scale on the same scorecard — and an unattended ingest refused the whole run. A run
where EVERY measured question is a singleton (0 comparative groups) is a broken run: an unattended ingest refuses
it, and the merge never lets its quality-null buckets erase stored judged quality (see **The store contract**).

**Fallback: per-answer ABSOLUTE scoring** (`defaultQualityJudge`, `QUALITY_RUBRIC` on the Utility seat, thinking
on, SCORE 1..5 + ISSUE — the nightly audit's judge) — only when the build has no comparative judge at all, the
judge shares a family with a candidate of the group (the family guard), or the comparative call fails; attended
runs only (an unattended run refuses, 28d9e351). Know the limits:

- **Same-family bias.** The judge model may share a family with a candidate (the built-in Utility seat is
  `deepseek-flash`; a GLM override would favour GLM). The comparative path skips a group whose candidate shares the
  judge's family (absolute fallback, disclosed); the ingest prints the judge's model and a ⚠ line for every spec of
  the same family. Pin a conflict-free `--judge-model` for a mixed-family run.
- **Code answers.** The default judge is a fast general model; a `code` kind run ranks code answers with it too —
  read code-kind quality with that in mind, or pin a stronger conflict-free judge for the code run.
- **One judge, no reference answer.** Time-sensitive answers are judged on whether they show they looked things up,
  not on ground truth. Quality differences under ~0.3 on n < 20 are noise. The NIGHTLY audit additionally feeds the
  judge a grounding note (the turn's verified web-tool-call count, ticket 3ff96116 recurrence 2026-10-14) — the
  BENCH passes no such context, so a bench answer's grounding is judged from its text alone.
- **Single-shot noise (measured 2026-10-09, ticket 3ff96116).** The judge's run-to-run spread on the SAME
  (message, answer) measured 3 on the 1..5 scale (the same answer scored 2,5,2,4 across four runs). The NIGHTLY
  audit now scores each sampled answer K times and collapses to the median (`LIVE_CHAT_AUDIT_QUALITY_REPEATS`,
  default 3; 1 restores the single shot). The BENCH ingest still calls the judge ONCE per answer — its quality
  numbers carry that single-sample noise; differences under ~0.5 on n < 20 should be read as noise (tightened
  from ~0.3 accordingly). For rank quality the per-question spread is larger still (K=3 ranks 5/3/1, sd ≈ 1.6), so a
  kind bucket under ~8 judged answers is noise — the picker reads a kind bucket only from 8 judged answers
  (`BENCH_KIND_MIN_N`) and shrinks it toward the model's lane quality.
- **The judge sees text only (nightly audit context, 2026-10-09).** The nightly audit hands the judge an
  ATTACHMENT note when the user message carried images/documents (pixels the judge cannot see) and appends the
  turn's side-row continuation (`deeper_findings` / `deliverable_handoff` …) so it scores what the user received.
  The BENCH ingest passes no context (bench questions are plain text) — unchanged.
- **The test account's memory evolves during a run** (facts extracted from earlier bench answers can be recalled by
  later ones). The rotation spreads that across models; it does not remove it.

## Task kinds (2026-10-20)

The real-user audit (`docs/AUDIT_2026-10-20_REAL_USER.md`) saw the per-turn pick rank a birthday poem, a cover letter,
a logo brief and a Python function byte-identically: its evidence was keyed (model, lane) only. The bench now
measures quality per **task kind** — the job a question asks for — in the ONE vocabulary
`backend/src/modules/crossmodel/platform/task-kind.ts` owns (`TASK_KINDS`: `writing`, `code`, `analysis`, `lookup`,
`advice`, `planning`, `explain`), which the `task_kind` decision also classifies every human turn into.

- **Which kind a question is.** Its corpus GROUP decides (`GROUP_KIND` in `model-bench.py` = `BENCH_GROUP_KIND` in
  the TS leaf — both twins are pinned: the Python self-test parses the TS text and
  `backend/src/scripts/model-bench-kind-twins.test.ts` parses the Python): writing ← writing, paste, lang · code ←
  code · analysis ← math, opinion, complex · lookup ← lookup, trivia, news, local, shopping, tools · advice ← health,
  money, advice, compare · planning ← plan · explain ← explain, howto, homework, cooking.
- **The title token — KIND runs only.** A kind run's chats (`--kinds` or `--per-kind` given) are titled
  `model-bench <runId> q<idx> <spec> k:<kind>` — an OPTIONAL strict trailing token (`k:` + lowercase letters;
  `model-bench r1 q1 glm 5.3` still never parses; an unknown kind token parses without a kind and counts by lane
  only). The kind therefore sits on the chat row, survives a re-ingest and puts every model's answer to one
  question in the SAME bucket. A default / `--groups` / `--lanes` / `--question-set` run (`--question-set kinds`
  alone included — it only widens the question pool) writes PLAIN titles exactly as before the kinds (2026-10-20
  review — its `--dry-run` lines, which mirror the titles, are byte-identical to the pre-kind bench; the JSONL
  records still carry the question's `kind` for the local report): a routine 12-question refresh would otherwise
  file 1–4 title-keyed rows per (spec, kind). Its rows still land in kind buckets through the answer's classified
  kind (next bullet) — the merge's keep floor (**The store contract**, rule 2) stops those thin buckets replacing
  the deep ones a kind run built. **Deploy order:** the ingest + scorecard leaf that read the
  token must be live on box A before a KIND run — an older scorecard leaf (`/app/dist`) skips `k:` titles as "other
  title" (the ingest names such titles in a ⚠ line — deploy, then re-run the ingest).
- **The classified kind.** The answer's own `metadata.depth.turnPlan.taskKind.kind` (the `task_kind` decision) is
  read as `planKind`: the bucket key when a title carries no kind. The bench records it as `plan_kind` in the JSONL
  and both the bench report and the ingest print an agreement line (counts only — the bench: the question's kind vs
  the classified kind; the ingest: the title kind, so kind runs only), a free calibration readout for the classifier.
- **The kind question set.** `KIND_CORPUS` (bench-only, kept out of `human_corpus.py` so the nightly suite's samples
  never change) adds 10 real code tasks, 7 planning, 7 analysis and 5 writing / creative asks (incl. business-name
  ideas and a logo brief) so every kind has ≥ 10 templates; the 2026-10-20 wave-B set adds 77 more (authored,
  adversarially critiqued, then kept only when three BLIND classifiers all named the intended kind) so every kind has
  25–35 and a run can take two waves of 10 per kind. The same blind vote found seven corpus entries whose GROUP's kind
  was wrong (a laptop recommendation filed as lookup, "how do i ask my boss for a raise" as explain …) — they carry a
  `kind=<k>` flag now. `--question-set kinds` = corpus + KIND_CORPUS +
  TOOL_CORPUS; `--kinds` switches a corpus / mixed run to it.
- **`--kinds k1,k2`** draws the kinds' groups (a union with `--groups` / `--lanes`), n questions stratified across
  those groups; `code` questions (flagged `code`, skipped otherwise) run only when `code` is one of the kinds.
- **`--per-kind K`** asks K questions of EVERY selected kind (all seven when `--kinds` is absent), stratified across
  each kind's groups and interleaved across kinds; it replaces `--n` and is refused with `--groups` / `--lanes`.
- **Bench every candidate in ONE kind run.** Rank quality is relative to the field: a model's writing bucket from a
  3-model run and another model's from an 8-model run are not on one scale (`fieldSize` shows it). Include the
  current seat and every model you want considered, and ask ≥ 10 per kind (the picker reads a kind bucket only
  from 8 JUDGED answers — failures, failovers and singleton questions are never judged). A kind bucket with ≥ 8
  judged answers is KEPT against any thinner incoming one (a routine run, or a kind run that lost answers), so a
  deep bucket is refreshed only by another run that reaches 8 judged answers on that kind.
- **More answers per kind: a second wave of the SAME run id.** A later run REPLACES a kind bucket, so a second run id
  never adds to the first; one ingest of one run id ranks every wave it holds. Two ways:
  - **after wave 1 has exited:** `--continue-from <wave-1.jsonl>` (repeat it / comma-list EVERY earlier wave file) —
    questions are numbered after the last `q<idx>` and never repeat a template the earlier waves asked (a template
    matches its own slot fills). Refused when a wave file is incomplete (a q missing a model — the wave is still
    running or was cut), when the earlier waves mix title modes, or (after the preflight) when the model field differs.
  - **beside a still-running wave 1:** `--start-idx N` past every idx wave 1 uses (e.g. 101 beside a 70-question wave)
    with `--avoid <wave-1 plan>` (a JSON list of its question texts — `--dry-run` of wave 1's command at wave 1's
    commit prints them) and `--pacer-starts 8` (both processes share the 25 / 10 min / IP limiter and neither retries
    a 429 — keep the two caps under 25 together).
  Either way the bench reads the run id's chats ON THE SERVER before its first stream and refuses a first `q<idx>`
  at or below the server's highest (a title collision ranks two questions as one), a different model field (ranks are
  comparable only within one field) or a different title mode; a fresh run onto a run id that already has bench chats
  is refused. A continued wave writes `model-bench-<runId>-q<first>.jsonl` / `.md` by default.
- **A corrected kind after a wave ran:** `--relabel <wave.jsonl>` (a FINISHED wave only) re-files the chats whose
  corpus entry now carries another kind — it retitles their `k:<kind>` and rewrites the JSONL; `--dry-run` lists them.
  `--continue-from` warns when an earlier wave needs it. A per-question `kind=<k>` flag in a corpus entry overrides
  its group's kind (the `lang` group mixes a translation, a grammar question and a lookup asked in Spanish); a
  re-filed entry samples inside its new kind's home group (`KIND_HOME_GROUP`), never as a 1-entry stratum.

```bash
# Free: the plan
python3 scripts/e2e/model-bench.py --dry-run --models glm-5.3,deepseek-flash,kimi-k3 --per-kind 10 --seed 1020
# A full kind run (7 kinds × 10 × 3 models = 210 streams ≈ 100 min pacing floor)
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py \
  --models glm-5.3,deepseek-flash,kimi-k3 --per-kind 10 --seed 1020 --run-id mbk1020a --drop-refused
# A second wave of the same run once wave 1 has exited (new templates only, numbered after wave 1)
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py \
  --models glm-5.3,deepseek-flash,kimi-k3 --per-kind 10 --seed 1021 --run-id mbk1020a --drop-refused \
  --continue-from model-bench-mbk1020a.jsonl
# …or beside a still-running wave 1: number past its plan, avoid its plan, share the limiter
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py \
  --models glm-5.3,deepseek-flash,kimi-k3 --per-kind 10 --seed 1021 --run-id mbk1020a --drop-refused \
  --start-idx 101 --avoid wave1-plan.json --pacer-starts 8
# Re-file wave 1's chats whose corpus kind was corrected after it ran (once it has exited)
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py --relabel model-bench-mbk1020a.jsonl
# Judge: a family no candidate belongs to (2026-10-20: qwen3.6-27b — the gateway mimo judge left the catalog).
# A failed comparative call is retried (--judge-attempts, default 3) before it counts — an unattended ingest refuses
# the whole run on any judge failure that survives the retries.
bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id mbk1020a --judge-model qwen3.6-27b
```

## Cost and time

- Streams = N × M (e.g. 20 questions × 4 models = 80; `--per-kind K` → N = K × kinds). Pacing floor ≈
  ⌊(streams − 1) / 20⌋ × 10 min (80 → 30 min);
  real wall time is usually longer (each answer 10 s – several minutes; research-lane questions longer — restrict
  with `--groups` to keep councils out).
- Spend = N × M ordinary chat answers on the test account, plus the turn-plan decision per question and the
  Double Checker on checked-lane questions; the judge adds one Utility-seat call (thinking on) per measured answer.
- The chats are KEPT until the ingest has run; clean up with the ingest's `--cleanup` or `--cleanup-run`.
