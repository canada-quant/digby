# Live query suite — routing + tool usage (runbook)

`scripts/e2e/query-suite.py` sends a **seeded random sample of real questions**
through the production chat stream and checks how each one was routed, which
tools ran, how long it took, and whether the chat transcript stayed coherent.
Use it after any change to the Auto router, the `turn_plan` decision / Quick
lane, a model seat, the chat doctrine, or a chat tool, and before an owner act
flip. Added 2026-10-04 (dynamic roster, `docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md` §7).

> **It costs real money.** Every case is a real model run (a research case can
> be a 15-minute council). Run it by hand. CI runs only the offline self-test
> (`scripts/e2e/query-suite.test.sh`, in `.github/workflows/ci.yml`'s
> script-test loop). Do not put the live suite on a schedule without the
> owner's go-ahead.

## Profiles — which account runs what

| Profile | Account (env) | Runs | Never |
|---|---|---|---|
| `test` (default) | the canonical prod test account — `DIGBY_E2E_EMAIL` / `DIGBY_E2E_PASSWORD` | quick, standard, checked, research, tools, memory, multi, dig, files, platform | integrations (it has none connected) |
| `owner` | the owner's own account — `DIGBY_E2E_OWNER_EMAIL` / `DIGBY_E2E_OWNER_PASSWORD` (owner-authorized 2026-10-04 for external-tool checks; pass at run time, NEVER commit or write them anywhere) | `integrations` only: READ-ONLY Gmail / Calendar / Drive / GitHub / Slack / Asana / Xero / Plaid / X / iMessage + the account overview | any write, memory, files, images, schedules; `--cleanup` is forced (its chats are deleted) |

The owner profile first reads `GET /crossmodel/<x>/status` for google, github, slack, asana, xero, plaid, x,
imessage, telegram and never samples a case for an integration that is not connected. Every integration case is
`read_only`: ANY write tool in the run (gmail_send_email, gmail_create_draft, calendar_create_event, Docs / Sheets /
Drive writes, slack_post_message, asana_create/update_task, x_post, imessage_send, notify_user, …) is a FAIL.
Writes to external services are not exercised at all — they need the owner's OK per run. **Xero is skipped** (`SKIP_INTEGRATIONS`, owner 2026-10-04: not in use — its stale connection reads connected but every call returns 403, which is expected).

**Prefetch counts as grounding.** The controller pre-fetches integration data on a regex intent BEFORE the
run (`backend/src/modules/crossmodel/integration-context.ts` — Gmail / Calendar / Drive, GitHub, X, Slack, Asana,
Xero, Plaid, iMessage; a `progress` event with that `stage` streams) and injects it into the context, so a
grounded answer can carry no tool call. The whole prefetch is BOUNDED (ticket 11d98377, 2026-10-10: it sits
before the run starts, so a wedged leg was first-word latency on every lane): a 45 s race
(`INTEGRATION_PREFETCH_DEADLINE_MS`, ≤ 0 disables) starts the run with whatever settled — legs keep settling in
the background and the agent can still call the read tools itself. An integration case passes on a read tool of its family OR its family's
prefetch stage (a WARN names it). The account-overview case answers from the `[YOUR INTEGRATION STATUS]` block
(get_account_overview is preferred only), and the tools-category X twin (x-trends) takes the same prefetch
grounding — the controller's X prefetch fires on the same "search X / trending on X" regex intent (44f0cafc:
the 2026-10-07 nightly's zero-tool answer WAS the injected site:x.com SERP; an ungrounded no-tool answer still
FAILs). **X fence (44f0cafc B1):** the X stage streams BEFORE its fetch legs resolve and a wholly-degraded read
can inject a failure note with no follow-up event, so an X stage sighting grounds only when the xUnavailable
progress did NOT stream AND the answer does not echo the injected failure vocabulary ("X isn't responding…",
"X DATA UNAVAILABLE", "X READ DEGRADED", …) — a degraded prefetch is a named FAIL, never a green WARN.

## Run it

```bash
# Free: the catalog, the sampled cases, the evaluator's self-test
python3 scripts/e2e/query-suite.py --list
python3 scripts/e2e/query-suite.py --dry-run --n 22 --seed 303
python3 scripts/e2e/query-suite.py --self-test

# Live (prod) — the canonical test account (AGENTS.md "Canonical prod test account");
# never register a throwaway account
DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=<AGENTS.md> \
  python3 -u scripts/e2e/query-suite.py --n 22 --seed 303 --concurrency 3 \
  --out run.jsonl --report run.md --cleanup

# Live READ-ONLY integration checks on the owner's account (credentials from the owner, at run time only)
DIGBY_E2E_OWNER_EMAIL=... DIGBY_E2E_OWNER_PASSWORD=... \
  python3 -u scripts/e2e/query-suite.py --profile owner --n 10 --concurrency 2 --report owner.md
```

| Flag | Meaning |
|---|---|
| `--n` / `--seed` | sample size / RNG seed (same seed ⇒ same cases; omitted ⇒ random, printed) |
| `--profile` | `test` (default) or `owner` — see Profiles |
| `--categories` | comma list (default = the profile's): `quick, standard, checked, research, tools, memory, multi, dig, files, platform` (test) · `integrations` (owner) |
| `--concurrency` | parallel cases (≤ 4); the pacer still holds ≤ 20 stream starts per rolling 10 min |
| `--max-research` | research cases per run (default 1 — they are long and expensive) |
| `--case-timeout` | client read deadline per stream (s, default 900); the run continues server-side |
| `--settle` | after a client timeout, how long to wait for the answer row (s, default 300) |
| `--out` / `--report` | JSONL per case / a markdown report |
| `--cleanup` | delete the chats the suite created **and sweep the suite's fixed-name file artifacts off the account** (test profile: `rate.md`, `ideas.md`, `notes.txt`, `budget.xlsx`, `week.xlsx`, `groceries.xlsx`, `Packing list.md` — the last is the fixed TITLE the create-document case names; a `GeneratedFile` row's `chatId` is a bare column with NO FK, so a chat delete never cascades to it; 1f67492f + self-audit D1. The sweep also runs BEFORE a live test-profile run, so a create ask on a used account is a CREATE, not a refresh of a previous night's leftover. The model INVENTS filenames for the doc-format asks — a name-based sweep cannot cover those, and the case adjudicates on its own merits) **and sweep the suite's own memory facts and topic bans** (`favourite tea` / `favourite_tea` / `fav tea` / … every fav-vocab key shape the extractor writes, plus `__` bookkeeping incl. `__rejections` — the do-not-mention bans; via `GET /crossmodel/memory` + `DELETE /crossmodel/memory?key=…`; 6fd4663a — a chat delete never touches the account-level userMemory blob, so an earlier run's "please forget my favourite tea" left a persistent ban a later run's remember turn had to fight; the sweep runs BEFORE a live test-profile run and on `--cleanup`, sparing every non-suite fact; the owner profile never sweeps) |
| `--base` | API base (default `https://digby.ai/api`, env `DIGBY_E2E_BASE`) |

Exit 0 = no FAIL, 1 = at least one FAIL, 2 = usage / login error. Progress
lines (`[k/N] <case> → VERDICT`) stream as cases finish; the table, a JSON
summary (verdicts, Quick acts, latency by lane, tool-call counts) and the report
follow at the end.

## Catalog (what each category exercises)

| Category | Cases (randomized fill-ins) |
|---|---|
| quick | weather, currency, time, definition, latest champion, unit conversion |
| standard | haiku, explain-to-a-12-year-old, name ideas, rewrite, code (never Quick) |
| checked | drug interaction, debt vs invest, multi-step math, contested history |
| research | the Quebec question + three broad research asks (`--max-research`, run last) |
| tools | generate_image (square + 16:9), create_document md / docx / pdf / csv / xlsx (a canvas counts too — any of the THREE doctrine routes: the create_canvas tool, or the answer's own inline `[CANVAS]` marker with no tool call at all, which the chat prompt prescribes for standalone documents and create_canvas's description prefers; create_document preferred, an artifact must land), create → update chain, create → read-back chain, search → create_document chain, list_files, list_canvases, list_memory, get_account_overview (preferred only — the `[YOUR INTEGRATION STATUS]` context block already grounds the answer; read-only + an answer naming the state), fetch_image, scrape, web_pipe multi-page, search-and-compute, news, youtube_pipe, browser_task, parallel delegation, an ambiguous ask (ask_user allowed), X trends / search (public, no connection needed) |
| memory | remember_fact → recall in a FRESH chat → forget_fact |
| files | an HTML page "kept in my Files" → list → edit. Canvases were folded into the Files pane on 2026-09-23; an HTML page still lands as a canvas there (create_document makes no HTML), so the case accepts a canvas OR a generated file, listed with list_files / list_canvases and edited with update_canvas / update_document |
| platform | one platform read (schedules, spend, knowledge base, preferences, chat search, Telegram connect link), schedule a reminder IN THIS CHAT → cancel it, set this chat's instructions → the next answer obeys |
| multi | a follow-up in a contested (Checked) session must not act Quick |
| dig | a Quick answer → Dig deeper (verify rung, a "Deeper findings" row, preset thinking) |
| human | ~85 realistic messages (`scripts/e2e/human_corpus.py`) across 22 everyday groups — lookups, how-to, writing, explain, planning, comparisons, health / money / legal (stakes), math, code, pasted text, French / Spanish / German, opinion, emotional advice, deliberately vague, trivia, local, news, complex research-ish, shopping, cooking, homework — with randomized human noise (casual prefix / suffix, lowercase, one typo) |
| human_thread | multi-turn conversations with natural follow-ups ("make it cheaper", "shorter and funnier", "now in french", "what about the weekend?") |
| integrations (owner) | Gmail search, Calendar list, Drive / Sheets read, GitHub repos / PRs / issues / code search, Slack channels / search, Asana tasks / projects, Xero organisation / invoices, Plaid accounts (names + types only), X profile, iMessage conversation names (no text), the account overview |

Every run's summary lists the chat **tool families covered**, the ones **not exercised** this run, and the
families **excluded by design**: integration writes (external effect — a per-run owner OK), computer_task (drives a
real Mac), fill_pdf_form (needs a fillable PDF fixture), search_code_semantic (needs a workspace), messages that leave
the chat (notify_user, send_email_as_digby, send_chat_message, send_to_instance, dispatch_platform_task), share links /
autonomy / webhooks / project sharing (card-gated), start_coding_session / import_repo (long-running
background work) and delete_* tools (ask-first, destructive).

## Generic answer checks (every turn, 2026-10-04)

`generic_answer_checks` judges every answer without a per-case expectation: FAIL on internal text leaked into the
answer (`LEAK_RE` — a tool-call fragment, `<think>`, a harness marker); WARN on a refusal / false "I can't browse"
disclaimer of a benign ask (`REFUSAL_RE`), a hand-back ("say the word", "shall I proceed"), a multi-part ask answered in
< 300 chars, an answer in the wrong language (`LANG_WORDS` marker words), a time-sensitive question answered without a
web tool or prefetch, a code ask with no code block. The human corpus's per-message FLAGS (web / stakes / multi / lang /
code / vague) feed these; `stakes` also makes a Quick-lane ACT a FAIL. The nightly real-chat audit
(`platform/live-chat-audit.ts`) runs the same leak + refusal markers over every real answer and an answer-QUALITY judge
(1..5 + an issue category; `LIVE_CHAT_AUDIT_QUALITY_SAMPLE`, default 20) over a sample.

**The detector's counterpart on the production path (ticket 4d161561).** A leak signal is only actionable if the
delivered answer can be made clean by construction, so the chat-agent finalize runs every answer — the content AND
the text parts a reloaded chat renders — through `chat-agent/answer-scaffolding.ts stripAnswerScaffolding` before it
persists: reasoning tags (matched / mismatched / unterminated / stray), `<function=…>` and `<function_call>` /
`antml:` fragments, ASCII special tokens (`<|tool_call|>`, `<|endoftext|>`), the fullwidth-bar native token blocks,
echoed harness marker lines (`[HARNESS CLOCK]`, `[EVIDENCE LEDGER …]`, `[MACHINE-TRIGGERED RUN …]`, a `[HARNESS
NOTICE]` prefix) and a bare `{"name": <tool>, "arguments": …}` call object. Fenced code, block quotes and the
harness's own delivered guard chrome are never touched. `chat-agent/answer-leak.4d161561.test.ts` pins one fixture
per `ANSWER_LEAK_RE` alternative and fails both on a shape that survives AND on the detector gaining an alternative
the gate has not been taught — so `answer_leaks` should stay 0 without relaxing the detector. The live (streamed)
bubble is not covered by this gate: it reads the persisted row, which is what the audit and a reload both see.

## What it checks

Per turn, from the **stream** (both shapes):
- chat stream: `routing` (Auto level), `chunk` (first-token time), `agent-activity`
  `kind:'tool'` (tool calls by seat — Digby, Double Checker, council colleagues),
  `image` (`source:'generated'` = a generate_image result), `check_state`, the
  Quick lane's progress line "Quick answer — looking it up…", `ask-user`, `error`;
- coding-harness stream (a code-intent send such as "create a markdown file named
  ideas.md" attaches a workspace and runs `coding-stream.controller
  streamCapabilityRun`): `tool_call`, `text`, `complete`.

From the **persisted answer** (`GET /crossmodel/chats/:id`; the row right after
this turn's own user row, never a row count): `metadata.depth.turnPlan`
(lane / act / canary / reason), `depth.plan` (preset, lane), `metadata.models`,
`metadata.check`, `metadata.kind`.

After each case, a **transcript audit** re-reads every chat the case used:
a user row answered by more than one ordinary assistant row is a FAIL (the
2026-10-04 orphan-sweeper double answer); a verifier correction row is a WARN.
Side rows never count as answers — neither in the audit nor when the suite
picks a turn's answer row: `control_note`, `deliverable_handoff`,
`deeper_findings`, `continuation_result`, `check_addendum` / `council_addendum`
(the late Double Checker / council "**Update to an earlier answer**" row — it
can land AFTER the next user message, about the PREVIOUS turn), verifier rows,
and rows with origin `machine` / `agent` / `deliverable_handoff`. The list
mirrors `platform/live-chat-audit.ts SIDE_KINDS`; keep the two in step. (The
audit's own duplicate-answer sub-select is stricter since ticket 0f208004:
allow-listed to `origin='user'` OR a depth stamp, so status cards and every
other machine notice never count as answers there. The suite runs on the test
account's plain chats — no cards expected — so its simpler list stands.)

### Verdicts

| FAIL (hard) | WARN (soft) |
|---|---|
| a required tool did not run (`tools_any`), or a step of a chain is missing (`tools_all`) — a chain's document-CREATE step missing because the run REFRESHED the account's existing same-name file (`update_document`, non-errored, and only after a `list_files`/`read_document` sighting in the same run — 1f67492f B1: the credit is evidenced, not presence-based) is a WARN, create preferred | the turn-plan lane is not one of the expected lanes, or no plan was recorded |
| the answer misses a required pattern (`answer_regex`) | a fallback tool ran instead of the dedicated one (`tools_prefer`) |
| stream error / no answer row persisted | the run asked the user (`ask_user` — auto-answered with the first option so a parked run never hangs the suite) |
| the Quick lane ACTED on a must-not turn (stakes, contested, code, a follow-up in a deep session) | a quick-lane turn was not acted (with the plan's reason) |
| act recorded but the Quick lane did not run | the Quick lane ran without its progress line |
| generate_image ran but no generated image streamed | the run used the coding harness (file tools stand in for document tools) |
| a READ-ONLY (integration) case called any write tool | |
| the expected tool RAN but every call FAILED (read from the persisted answer `parts` — `tool_errors_of`) | another tool returned an error |
| a Files-artifact case produced neither a canvas nor a generated file (a create_canvas TOOL call or an inline `[CANVAS]` marker counts — both land in Files; a marker route with no tool call is a WARN, #1319 / 1da06d4e — fenced to artifact-expectation cases) | |
| the transcript audit found a question answered twice | a client timeout / a verifier correction row |

## Safety rules (pinned by the self-test)

- **Profiles:** the owner profile refuses every category but `integrations`, forces `--cleanup`, and uses its own
  env names; the test profile never runs `integrations`. No integration prompt contains a write verb, and every
  integration case fails on a write tool.
- **Safe tools only.** Web search / scrape / web_pipe / youtube_pipe /
  browser_task (cloud read), generate_image, create_document / update_document /
  list_files, remember_fact → recall → forget_fact (cleaned up),
  get_account_overview / list_memory / list_canvases. No template may ask for a
  schedule, a message to another chat, a feed, a share link, autonomy, or a
  coding session; the self-test fails if one does.
- **One account:** the canonical prod test account. It is the `turn_plan` act
  CANARY since 2026-10-04 00:31:48Z, so its eligible turns take the Quick lane
  while the purpose is still shadow fleet-wide.
- **Rate limit:** `/api/crossmodel/stream` allows 25 requests / 10 min per IP;
  the pacer keeps ≤ 20 starts per rolling 10 min and ≥ 4 s between starts.
- **Connect retries never double-act** (`connect_failure_retryable`, 2026-10-04): a request that failed BEFORE the
  server could act on it (urllib's `URLError` — connect / TLS handshake / send leg) is retried after 3 s and 10 s.
  A GET / DELETE and the stream (a GET) retry any such failure; a POST retries only on a refused connect, a DNS
  failure or a TLS handshake timeout. An HTTP status, and a timeout after the request was sent, are never retried.
- **Tokens:** access tokens live 15 min; the client re-logs in every 10 min and
  retries once on a 401.

## Nightly hardening loop (2026-10-04)

Two legs run every night, both feeding the framework's own ticket lane:

| Leg | Where | What | On a problem |
|---|---|---|---|
| **Real chats** | worker cron `live-chat-audit` (daily, box A's cron worker; `backend/src/modules/crossmodel/platform/live-chat-audit.ts`) | the last 24 h of REAL human turns, all users — bench-account chats excluded (by `MODEL_BENCH_ACCOUNT_EMAIL` and `model-bench` title prefix, ticket 18bce3f9): lane / act, first-token + completion time by lane, lead errors, empty answers, hand-back closings (evidence-gated, ticket 18bce3f9), Dig-deeper taps (and on Quick answers), thumbs down, double answers, verifier corrections on plain chats; a sample (30) re-asked to the turn_plan decision (segment `replay`, never pooled with human rows) and rated by a reasoning judge (20, the Utility seat with thinking on) | ONE deduplicated framework ticket per regression signal, title `[live-chat audit] …` (re-sighted nightly while it persists); summary in `loop_metrics live_chat_audit`; one line in ADMIN owner briefings |
| **Synthetic** | GitHub Actions `nightly-query-suite.yml` (10:17 UTC) | this suite, test profile, 10 cases, research excluded, seed = the date | ONE `[nightly query suite] failing cases` bug as the test account — deduped on the failure SET, not the title: it files unless an open nightly ticket already reports every failing case id (44f0cafc: the exact-title gate suppressed a NEW failure while an unrelated nightly ticket was open); the run goes red; report on the run summary + artifact |

Regression rules (`detectRegressions`, pure + unit-tested): any double answer; ≥ 3 verifier corrections; lead errors
≥ 3 and above max(5 %, 2× the 7-night baseline); ≥ 3 empty answers; ≥ 3 hand-backs; a lane's first-token p50 > 1.5×
its baseline (≥ 10 turns, ≥ 3 baseline nights); > 20 % of ≥ 10 Quick answers dug deeper; replay agreement < 85 %
(≥ 10 replayed; the ratio counts only turns the live ask actually CLASSIFIED — a failed live ask records
the preset fallback lane with no decisionId and is counted separately as `nFallback`, ticket 4c3f2a5c;
disagreements where the live ask's backend differs from today's are attributed as `backendDrift`);
≥ 2 acted Quick turns the judge rates checked / research; ≥ 3 research-worthy turns answered below
Level 3. Privacy: message text is read only inside the backend by the platform's own seats; rows, tickets and logs
carry counts and chat ids, never content. Switches: `LIVE_CHAT_AUDIT_DISABLED`, `LIVE_CHAT_AUDIT_TICKETS_DISABLED`
(report only), `LIVE_CHAT_AUDIT_REPLAY_SAMPLE`, `LIVE_CHAT_AUDIT_JUDGE_SAMPLE`; the workflow: disable it or set the
repository variable `NIGHTLY_QUERY_SUITE_DISABLED=1`. Secrets: `DIGBY_E2E_EMAIL` / `DIGBY_E2E_PASSWORD` (test
account, set 2026-10-04).

## Offline model bench (2026-10-04)

`scripts/e2e/model-bench.py` reuses this suite's client (`Api`, `Pacer`, `find_answer`) to run the SAME
human-corpus questions (filled, never noised, stratified across groups) on several lead models through the real
pipeline — one chat per (question, model), titled `model-bench <runId> q<idx> <spec>`, the lead pinned with the
per-chat `leadModel` override, model order rotated per question. `scripts/framework-audit/model-bench-ingest.js`
(via `prodq.sh`) then judges every answer with the nightly audit's quality judge and merges the per-model, per-lane
scorecard into the context store (`['instance','model-bench'] / 'scorecard'`) that the lead picker reads. Test
account only. Runbook, store contract, attribution rules and the judge's bias: [`docs/MODEL_BENCH.md`](MODEL_BENCH.md).

## Adding a case

Add a `tpl_<name>(rng)` function returning
`{'category', 'name', 'turns': [...], 'expect': [{...per turn...}]}` and list it in
`CATALOG`. Optional keys: `fresh_chat_turns` (turn indexes sent in a NEW chat —
the memory recall uses one so it proves the stored fact, not the transcript),
`dig: True` + `expect_dig` (tap Dig deeper on the last answer), and per-turn
`lanes`, `quick_act`, `no_quick_act`, `no_quick_act_if_prior_deep`,
`tools_any`, `tools_all`, `tools_prefer`, `images_generated`, `answer_regex`,
`ask_ok`. Randomize through `SLOTS` so repeated runs cover different inputs.
Then run `bash scripts/e2e/query-suite.test.sh` (offline) and a small live run.

## Findings log

| Date | Run | Result | Finding → fix |
|---|---|---|---|
| 2026-10-04 | smoke, seed 21 (3 tools cases) | 2 PASS, 1 FAIL | **Same question answered twice**: the orphan sweeper's Rule B re-fired a 462 s run's user row in the instant the run finished (snapshot race) → `orphan-recovery.ts rowStillLatest`, `CHAT_ORPHAN_LATEST_RECHECK_DISABLED`. **False verifier correction** on "my browser task timed out" → `action-verifier.ts` failure-report tier, `ACTION_VERIFIER_FAILURE_REPORT_EXEMPT_DISABLED`. Slow first tokens on the gateway GLM-5.3-flash lead (310–460 s on tool turns). |
| 2026-10-04 | seed 303 (22 cases / 26 turns, canary live) | 20 PASS, 1 WARN, 1 FAIL | Quick lane acted on 6 turns, none wrong; no-tool lookups 7.8 s / 19.1 s, web lookups 44.6–161.8 s (3–5 chained tools) → the Quick-lane brief (`chat-agent/quick-lane-note.ts`, `QUICK_LANE_BRIEF_DISABLED`). Quebec research question read lane standard 0.365 vs research 0.355 (contested 0.97, breadth 4) → phase-3 trait rule. The FAIL was a suite gap (coding-harness stream frames + supervisor `control_note` rows) → fixed in the suite. |
| 2026-10-04 | seed 77, tools + memory (12 cases) | 12 PASS | Every tool family ran as asked: create_document (docx / csv / xlsx, plus an update_document revision), generate_image ×2 (image streamed), fetch_image, scrape, browser_task, youtube_pipe, web_pipe news, get_account_overview, list_files. The Quick lane took the scrape (21.4 s), news (80.7 s, web_pipe) and an explicit "use the browser" ask (120.4 s) → the lane brief now yields to an explicit tool ask. Slowest: YouTube summary 211 s to the first token (search + web_pipe + youtube_pipe on L2). |
| 2026-10-04 | prod readout TP1004B (real chats, 7 d) | — | The double answer HIT REAL USERS: 4 orphan re-fires on human chats in 7 days, all 4 on already-answered rows (fixed in #1236). 4 action-verifier corrections on real plain chats (09-28 / 09-29) besides the suite's. The owner's 4 turns since the turn plan shipped all read lane standard; one Level-1 turn took 360 s to the first token and was corrected by the owner's next message (a re-ask). |
| 2026-10-04 | owner profile, 11 integration cases (all 9 integrations connected) | 8 PASS, 3 FAIL → 0 real failures | Gmail, Calendar, GitHub (PRs), Slack, Asana, Xero, X and iMessage each called the right READ tool; no write tool ran; 11 chats cleaned up. The three "no tool" answers (Plaid accounts, today's Drive files, the integration list) were grounded by the controller's regex PREFETCH (`integration-context.ts`) or the status block — a suite expectation gap, fixed (prefetch stage = grounding). Notes: x_get_user_profile / imessage_list_chats / slack_search were each called 4–6× in one answer (repeat calls); Slack search took 112 s to the first token; Jev put 8 of 11 integration reads in lane **quick** — the Quick lane on integration tools is untested (the owner is not a canary). |
| 2026-10-04 | seed 404, quick + dig after the Quick-lane brief (#1236) | 6 PASS | Quick lane: sports 68.8 → **28.1 s**, weather 44.6 / 93.2 → **31.1 / 30.2 s**, definition 36.2 s, time 10.1 s, units 7.3 s — one search_engine call each. |
| 2026-10-04 | owner profile, 14 integration cases, Quick lane in ACT fleet-wide | 13 PASS, 1 WARN | Every integration read worked and stayed read-only (14 chats cleaned up). Jev read lane quick on 10 of 14 but only one cleared the 0.8 bar (GitHub issues: acted, 46 s, the Quick model called github_list_issues correctly); the rest read p 0.45–0.79 and ran their preset (16–39 s — the controller prefetch keeps them fast). Slack search is the slow outlier: 259 s to first token, 6 Slack calls on L2. WARN = Plaid answered from the prefetch (correct). |
| 2026-10-04 | GitHub Actions `nightly-query-suite.yml`, manual dispatch (n 6, seed 1004) | 6 PASS | The synthetic nightly leg works end to end from the runner (secrets, pacing, cleanup): multi-page read, money, YouTube, contested, Quick sports, browser. |
| 2026-10-04 | first live-chat audit pass on prod data (report-only, one-shot LCA1004B) | 1 regression (no ticket — report-only) | 50 human turns / 24 h: Quick lane ran 9 (first token p50 68 s — before the lane brief deployed), other lanes p50 67 s, replay agreement 30/30, judge agreed with the live lane 14/15, 3 double answers (all before the fix deployed ~01:45Z), 2 hand-backs. The scheduled run starts 2026-10-05 04:08Z (a new cron's first firing is one interval out). Replays now skip the shadow challenger asks (`decide({challengers:false})`). |
| 2026-10-04 | prod error scan after the owner run (ERR1004) | — | 19 Xero API failures the suite had marked PASS: the tool RAN, so the case passed, while `callXeroApi` swallowed the HTTP error into "No result from Xero …". Fixed both sides: Xero tools now return the reason (reconnect / rate-limited / down), and the suite FAILS a case whose expected tool ran but failed. |
| 2026-10-06 | nightly run 37498350617 (profile test, seed 20261006), ticket ccd634fb | 3 FAIL of 14 → all three fixed by cae452485 (see correction) | **Adjudication CORRECTED 21:50Z** — this lane first read 02/03 as model behavior (list_memory showed no saffron fact; set_chat_instructions was verified in the chat lead's toolset); main's cae452485 ("remember lifts a stale ban, an unsaved chat rule re-runs once, browser banner only when the limit bit") found the deeper product causes and shipped before this lane's competing suite change (PR #1308's regex variant was REVERTED in favor of main's TASK_RESULT_HEADER_RE approach, which drops the formatter-owned success header but keeps the INTERACTION UNAVAILABLE banner as a failure — the banner now fires only when interaction was genuinely needed). Main's fixes: (02) the account's `__rejections` held "favourite spice" from an earlier nightly forget, so the recall turn saw a [BANNED TOPICS] block beside the fact — an explicit remember now lifts bans that would scrub the stored fact (context.service liftRejections), and "favourite"/"favorite" are never scrub keywords alone; kill switch MEMORY_REMEMBER_LIFTS_REJECTION_DISABLED. (03) glm-5.3 complied in-text without calling set_chat_instructions — a human turn that sets a standing chat rule but saved nothing now re-runs ONCE with a harness check (chat-agent/standing-rule.ts); kill switch CHAT_RULE_UNSAVED_RETRY_DISABLED. (05) with CLOUD_BROWSER_CDP off every cloud session is read-only, so the INTERACTION UNAVAILABLE banner rode every pure page read — glm-loop now emits the banner only when the limit bit (refused interactive action / needs_interaction / could-not-click answer), and query-suite.py drops the formatter-owned success header ("local browser: not connected" matched `not connected`) via TASK_RESULT_HEADER_RE. Tests: memory.graph.remember-lift.ccd634fb, context.service.remember-lift.ccd634fb, standing-rule.ccd634fb, browser-agent; suite --self-test. |
| 2026-10-04 | owner decision | — | Xero is not in use: the 403s are expected, not a regression to chase; the owner profile no longer samples Xero (`SKIP_INTEGRATIONS`). The Xero error-surfacing fix stays (a user with Xero gets the reason). |
| 2026-10-04 | broad, seed 5050 (24 cases incl. human + human_thread) | 22 PASS, 1 WARN, 1 FAIL → 0 real failures | The FAIL ("answered 2 times: 'in that page, make the main button blue'") was a suite misread: the late Double Checker's `check_addendum` row about turn 2 landed after turn 3 was sent, and the suite both counted it as a second answer and read it as turn 3's answer. The suite now skips every side row when it picks an answer (`find_answer`) and lists the two addendum kinds (self-test pinned). The WARN: `create_document` with format `html` is refused (html is a canvas, not a document) and the model spent a call before falling back to a canvas — the refusal now names the `[CANVAS:type=html,…]` route (`document-generator.ts`). |
| 2026-10-06 | nightly 37539254348 (ccd634fb verification re-run, seed 20261006, memory+platform+tools) | 10 PASS, 2 WARN, 2 FAIL → 0 real failures | Both FAILs were suite over-strictness (ticket 92857a41), not product bugs. **05-tools-create-document** (lead create_canvas + answer-head "it's open in the canvas panel"): the chat playbook's own row routes "make a document they can open → create_canvas" while `create_document`'s description claims every document ask — two first-class routes, and the suite accepted only one. The case now takes either tool (create_document preferred → a canvas is a WARN) and hard-checks that an artifact actually landed (a create_canvas TOOL call counts; canvases folded into Files 2026-09-23). Root cause of the seed-to-seed flip (seed 303 → create_document, 20261006 → create_canvas): the playbook named ONLY create_canvas, so the pick was luck. The row now splits file-vs-open: a downloadable FILE (md/docx/pdf/csv/xlsx, "save a file", a named extension) → create_document (html is a canvas, never a file). **13-tools-account-overview** (single_thinking, zero tools, 9.1 s, "everything is disconnected"): integration state rides EVERY signed-in turn's `[YOUR INTEGRATION STATUS]` context block, doctrine says to call get_account_overview "only for state it lacks", and the runbook already adjudicated the integrations-category twin that way ("prefetch counts as grounding"). The answer was correct (corroborated: the same run's x_search hit an X login wall). The case now mirrors the integrations twin: tools_prefer + read_only + answer_regex — a grounded no-tool answer PASSES, a non-answer or a write still FAILs. Also: turn records now persist `canvases` (the inline-canvas count off the complete event) for post-hoc adjudication. |
| 2026-10-07 | nightly 37556487363 (seed 20261006, memory+platform+tools), ticket 1da06d4e | 11 PASS, 2 WARN, 1 FAIL → 0 real failures | The FAIL (**05-tools-create-document**, zero tools, 24.8 s, answer-head "it's open in the side panel") was suite over-strictness, not a product bug: the run took the THIRD doctrine route for a document ask — the answer materialized the artifact itself as an inline `[CANVAS]` marker with NO tool call at all (`canvases: 1` off the complete event; the marker was stripped before `answer_head`). The chat prompt prescribes exactly that for "substantial STANDALONE artifacts the user will edit or reuse (… documents)" (chat-agent.service.ts, the synthesis-stage row) and create_canvas's own description PREFERS the answer's markers ("prefer the answer's own canvas markers when you are writing an answer"). The evaluator fix — a `tools_any` miss softens to a WARN when the artifact landed (`artifact_route`) — landed on main as **PR #1319** (squash 4ece357bd, the 92857a41 lane's post-merge verification of this same run, merged 01:42:29Z). This ticket's PR adds what #1319 lacked: the FENCE self-test pins (a no-artifact-key ask — tpl_tool_sheet / tpl_tool_doc_format — stays a hard FAIL even with a canvas; an .xlsx/.docx/.pdf/.csv deliverable as a canvas is a real miss, not a route choice) and this adjudication record. The artifact hard-check is unchanged. |
| 2026-10-07 | nightly 37559670187 (seed 20261006, memory+platform+tools), ticket 44f0cafc | 11 PASS, 2 WARN, 1 FAIL → 0 real failures | The FAIL (**01-tools-x-trends**, thinking route, Quick lane acted, zero tools, 49.4 s first chunk) was suite over-strictness, not a product bug — the same class as 92857a41 / 1da06d4e / the ccd634fb 13-account-overview fix. The turn WAS grounded: the controller's X prefetch (integration-context.ts) fired on the "search X for …" regex intent BEFORE the run and injected the site:x.com SERP (x-mcp's degraded read leg — "via Google SERP (site:x.com …) — Google-indexed X posts") into the context; the record persisted `prefetched: ['x']`, and the answer's own caveat ("the live read came through Google's index of x.com") paraphrases that injected provenance note — the model was DESCRIBING its grounding, not fabricating a read. **Fix:** tpl_x_public takes the same `prefetch_ok: 'x'` grounding as the integrations twins (a grounded no-tool answer is a WARN naming the prefetch; an ungrounded one still FAILs — pinned in the self-test), FENCED per the adversarial review's blocking finding: the X stage streams before its fetch legs resolve and a wholly-degraded x-mcp read injects a failure note with no follow-up event, so an X sighting grounds only when the xUnavailable progress did NOT stream AND the answer does not echo the injected failure vocabulary — a degraded prefetch is a named FAIL, never a green WARN (pinned: unavailable event, echoed vocabulary, and the 2026-10-07 answer shape still WARNs). **Second defect (the reason this ticket exists at all):** the nightly's filing gate deduped on the exact TITLE, so while the 92857a41 nightly ticket was still open it printed "failure ticket: exists" and this NEW failure was never filed — preserved only because a lane filed it by hand. The gate now dedupes on the failure SET: it files unless an open nightly ticket already reports every failing case id (a NEW failing id always files; unparsable/empty never counts as covered — pinned). |
| 2026-10-07 | nightly 37583488128 (seed 20261006, profile test, 14 cases), ticket 1f67492f | 10 PASS, 3 WARN, 1 FAIL → 0 real failures | The FAIL (**08-tools-search-then-document**, 39.3 s first chunk, 180.5 s done, tools: list_files, read_document, run_command, scrape_as_markdown, search_engine, search_memory, update_document, update_plan — the CODING harness) was a suite hygiene gap, not a product bug: the account held **`rate.md` created by the 2026-10-07 01:19Z run (37556487363 — that run's own turn WARN'd after a `create_document`; verified live: the GeneratedFile row's createdAt is 01:24:57Z)**. A `GeneratedFile` row's `chatId` is a BARE column with no FK (schema.prisma), so `--cleanup`'s chat deletion never cascaded to it — the leftover survived every later re-run. (The 2026-10-06 22:14Z run's `write_file` deliverable landed as a chat-scoped hand-off ChatFile, which chat cleanup DOES delete — the surviving row was the GeneratedFile one.) The 03:15Z and 06:47Z re-runs then did the honest thing: `list_files` → `read_document` found the prior note, and each REFRESHED it with `update_document` (answer-head: "Done — here's today's EUR/USD rate and the refreshed note"; update_document's own contract: "use when the user asks to change, extend, or correct a file you created earlier") — the user got a correct, current rate.md while the suite's `tools_all: [WEB_TOOLS, ['create_document']]` hard step starved → false FAILs (the 01:57Z re-run WARN'd only because its own `write_file` was TOOL_EQUIV-credited as create_document). **Fix (both halves):** (1) HYGIENE — the test profile sweeps the suite's seven fixed-name files (`rate.md`, `ideas.md`, `notes.txt`, `budget.xlsx`, `week.xlsx`, `groceries.xlsx`, `Packing list.md` — the last is the fixed TITLE the create-document case names, added by the self-audit D1 follow-up after a live probe showed it stranded on the account at 02:00Z while the sweep skipped it, the same false-FAIL class) off the account BEFORE a live run and again on `--cleanup`, via `GET/DELETE /crossmodel/generated-files`; the owner profile never sweeps (its cases create nothing); a broken sweep is read-only and never breaks the run. The model INVENTS filenames for the doc-format asks (barista-cover-letter.docx …) — a name-based sweep cannot cover those, so a leftover there stays and the case adjudicates on its own merits. (2) ADJUDICATION — a chain's document-CREATE step missing because the run refreshed the account's existing same-name file is a WARN (create preferred — the sweep is the real fix), FENCED to document-create steps only, and per the adversarial review's B1 finding the refresh credit is EVIDENCED, not presence-based: the `update_document` must be non-errored AND preceded in the same run by an account-files sighting (`list_files`/`read_document`) — an errored refresh (which `TOOL_ERROR_RE` now recognizes: "No generated file with id … belongs to this user", the real ownership-refusal string) or an unrelated-file update still FAILs hard. Pinned: the chat-engine refresh, the coding-harness `edit_file` twin (with its sighting), the errored-refresh B1 fence, the no-sighting B1 fence, the non-create fence, neither-create-nor-refresh, the sweep's row selection, both list shapes, a failing DELETE. |
| 2026-10-09 | nightly 37962929291 (seed 20261009, profile test), ticket 11d98377 | 12 PASS, 2 WARN, 0 FAIL — **latency gate BREACHED** (Quick-lane first-chunk p50 49.7 s > 45 s over 4 turns) | The four Quick turns: 7.4 s, 12.1 s (no-tool lookups, fast), **49.7 s (x-trends, ZERO tool calls — the whole wait was the controller's blocking integration prefetch)** and 62.5 s (news, 3 chained web calls: search_engine ×2 + search_memory). The p50 itself is the upper-median of 4 (`_pct` picks index ⌈0.5·3⌉) — a true median of [7.4, 12.1, 49.7, 62.5] is 30.9 s — but the two slow turns are real. Root causes: (1) **the prefetch blocks the run**: `crossmodel.controller.ts` fully awaits `buildIntegrationContext` BEFORE `startDetachedChatRun`, and the X trends leg scraped the always-walled `x.com/explore` (25–40 s) before the trends24.in mirror that works — pure first-word latency on every lane (prod `ux_ttft` probe, 14 d: the x-trends shape = 49.7 s with no tools). (2) The 3-call web chain: the Quick-lane brief says "at most ONE search_engine call" but the harness budget (`web-tool-cap.ts`) is **shadow by default** — 10 of 33 recent Quick runs made ≥ 2 web calls, 7 wouldRefuse, 0 refused; the act flip is the owner's `set-roster-policy.js quickWebCap=act` lever, not a code change. (3) The Quick lead (`cql-litellm:api-optimize-alibaba-qwen3.8-flash`, 81/81 quick turns, p50 48.9 s) rode the cql-litellm gateway degradation — ticket 4e74f0bb's model-pick recency arm landed AFTER this nightly (21:58Z vs the 17:05Z run) and now demotes degraded routes for role-pick too. **Fix (ticket 11d98377):** the controller's prefetch await is BOUNDED (`buildIntegrationContextBounded`, default 45 s = the Quick bar, kill switch `INTEGRATION_PREFETCH_DEADLINE_MS ≤ 0`; the race starts the run with whatever settled, legs keep settling in the background) and `x_getTrends` is **mirror-first** (the trends24.in mirror that works is leg 1; the always-walled x.com/explore scrape survives only as the fallback leg — replay: `x-mcp/src/x-read-fallback.23c68866.test.ts`, deadline race: `backend/src/modules/crossmodel/integration-prefetch.deadline.11d98377.test.ts`). |
| 2026-10-15 | nightly 38756194630 (seed 20261015, profile test, 14 cases), tickets afc10e95 + 6fd4663a | 12 PASS, 2 WARN → 1 FAIL + latency gate BREACHED | Two regressions from the same run. **(1) 6fd4663a — 02-memory FAIL (none of the expected remember/forget tools ran; answer missing /oolong/):** the remember turn "please remember that my favourite tea is oolong." was answered from a **persistent `__rejections` ban the suite itself planted** — an earlier run's forget turn ("please forget my favourite tea", ~Oct 7) left "favourite tea" in the account's `userMemory.facts.__rejections`, which rode every prompt as `[BANNED TOPICS — NEVER MENTION THESE … under ANY circumstances … permanent bans]`; the model obeyed the absolutist doctrine, refused the user's own explicit remember, and asked "do you want to lift that ban?" — never calling `remember_fact`, which is exactly the lift path (ccd634fb `liftRejections` lifts it server-side). Case 14 (same run, Catan) hit the same ban class and WARN'd. The 2026-10-06 saffron recurrence (ccd634fb) was the same disease at a different layer (ban vs stored fact); tonight's is ban vs the remember CALL itself. **Fix (three halves):** the BANNED TOPICS doctrine keeps its force for unprompted mentions but names the user's OWN explicit ask as the lift path (call remember_fact / answer directly; asking "do you want to lift that ban?" is a FAILURE MODE; ONE clarifying question only when genuinely ambiguous); the suite sweeps its own memory (every fav-vocab key shape + `__` bookkeeping incl. `__rejections`) BEFORE a live test-profile run and on `--cleanup` — the memory half of the 1f67492f file-sweep fix (a chat delete never touches the account-level userMemory blob); the owner profile never sweeps. **(2) afc10e95 — Quick-lane first-chunk p50 53.4 s > 45 s bar:** all five quick-ran turns ran the correct fast seat (qwen3.6-27b, preset single_thinking, lane ACT — turn_plan/tp_reason verified in run.jsonl); the time went to **2–4 web calls chained before the first word** (1 call ≈ 30.7 s, 2 ≈ 39.9 s, 3 ≈ 53.4–61.8 s: search_engine ×2 + search_memory / scrape_as_markdown), exactly the 2026-10-06 measured 3–5-call chains the lane brief (one search, one page, skip search_memory) was written against — advice the model drifts from, with the harness web budget (web-tool-cap.ts, 1 search + 1 fetch) parked in roster shadow (count-only, never refuse) since 2026-10-06. **Fix:** the Quick lane gets the same first-word opener right the plain-chat doctrine has (ticket 4f7263e4) — `quickFirstWordNote`, one honest line before the FIRST search, naming the lane's one-search budget so the two notes agree; same kill switch `FIRST_WORD_OPENER_DISABLED`; the opener rides the doctrine's cross-check slot next to the lane brief and the adapter's opener delivery already covers Quick turns. Pinned: the doctrine carve-out (7 tests), the quick note + kill switch (4 tests), the doctrine-level contract (compute-policy suite), the memory sweep (self-test: key shapes, owner-fact sparing, both list shapes, failing DELETE). |
