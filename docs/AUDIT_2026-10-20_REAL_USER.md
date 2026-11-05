# Real-user audit of plain chats — ask_user + the decision model (2026-10-20)

Owner asks: "audit and test digby sessions as a real user … i dont think we have the tool integrated like ask user to
give the model abilities to ask a user something either for clarification or creativity" and "make sure the decision
model is working and choosing the best models for the job in normal sessions that arent coding".

## Method

Twelve fresh plain chats on prod (`https://digby.ai`) as the canonical test account (`claudebot@digby.ai`, role USER,
`mode=auto`, the same SSE stream the web app uses, `X-Digby-View: full` so the turn plan is readable). When a run
asked a question, the probe answered the way a person would (a realistic detail, not the first option). Script:
`probe.py` (scratchpad, modelled on `scripts/e2e/query-suite.py`). All chats ran 03:24–03:31Z.

| case | message | ask_user? | turn-plan lane | ran | lead pick | first word | done |
|---|---|---|---|---|---|---|---|
| capital | what is the capital of australia | – | quick (0.97) | quick · qwen3.6-27b | – | 10.7 s | 11 s |
| weather | what's the weather tomorrow | no — assumed Toronto | quick (1.00), **Quick refused: stakes 0.62** | standard · glm-5.3 | seat | 13.6 s | **157 s** |
| poem | write a poem for my mom's birthday | no — generic draft | standard | **checked** · glm-5.3 + deepseek-flash | seat | 13.5 s | 16 s |
| logo | make me a logo | **no — invented an "aquaculture research" logo from memory** | standard | checked | seat | 22.6 s | 48 s |
| biz-name | I need a name for my new business | yes (1 question) | standard | checked | seat | 15.7 s | 153 s |
| trip | help me plan a trip | yes (1 question) | standard | checked | seat | 12.8 s | 231 s |
| cover-letter | can you write me a cover letter | yes (1 question) | standard | checked | seat | 31.4 s | 40 s |
| code | python fn: dedupe a list, keep order | – | standard | checked | seat | 9.8 s | 23 s |
| explain | explain attention in transformers | – | standard | checked | seat | 13.8 s | 27 s |
| phones | newest iPhone vs Pixel cameras | – | standard (0.64) | checked | seat | 11.4 s | 128 s |
| drug | ibuprofen with lisinopril | – | checked (stakes 0.91) | checked | seat | 17.5 s | 54 s |
| mortgage | pay off mortgage or invest? I'm 35 | no — answered with assumptions | checked (stakes 0.83) | checked | seat | 18.3 s | 124 s |

## ask_user — it exists, works end to end, and was under-prompted

- The tool is live on every plain chat (`CHAT_ORCH_TOOLS`), the web card renders it (`CodeSessionView` question
  card — markdown, quick picks, countdown, answer box) and the answer round-trips (`POST /chats/:id/questions/:qid`).
  Three of six underspecified asks used it, each with ONE well-bundled question.
- The failures were doctrine: the chat prompt said "call ask_user ONLY when a decision is genuinely human-worthy
  (irreversible/risky …) or you remain genuinely confused", and the tool description repeated it. Clarification and
  creative direction were not named, so "make me a logo" spent an image generation on a subject guessed from an
  unrelated memory fact, and "what's the weather tomorrow" guessed a city and then handed back "say the word if you
  meant somewhere else".
- The tool could not offer creative directions well: options were bare labels, single pick only.

**Shipped (this branch):** the chat doctrine and the tool description now name three uses — CLARIFY (a missing detail
that materially changes the result with no sensible default; one bundled question, before spending tools on a guess),
CREATIVE DIRECTION (taste decides the result: offer 2–4 directions, or draft-then-offer-variants when a draft is
cheaper), and the existing human-worthy decisions — plus "never fill a missing subject with an unrelated fact from
memory" and "never ask twice in one turn". The tool takes `options` as `"Label — one-line description"` and
`multiSelect`; the card shows each direction with its description, toggles picks on a multi-select question, and
sends "A, C — typed note". Older clients and every other surface (pending marker, inbox, answer tools) still read the
plain label list.

## The decision model on plain chats — working, but it does not choose per job yet

What works:
- `turn_plan` (TypeSafe Jev, calibrated, act) classified every turn sensibly: lane both orders, stakes / contested /
  live-web / multi-step / breadth. The Quick lane acted on the lookup (11 s end to end on qwen3.6-27b).
- The per-turn model pick runs in `act` mode with no frontier models (open-only rule held).

What does not:
1. **Depth for regular users is still the keyword router, not the lane.** Every non-lookup turn ran
   `routing.source: heuristic` → "default ensemble" → `plan.source: preset` → lead + Double Checker. The turn plan
   said `standard` (no checker) for poem / logo / code / explain / phones / trip / biz-name / cover letter, but
   `lane-depth.ts` `laneChecker` / `laneFailOpen` / `laneResearch` act only for the canary (the owner) — everyone
   else is shadow. Result: a checker on a birthday poem.
2. **The model pick cannot tell jobs apart.** Its evidence is per (model, lane) only — the ranking was byte-identical
   for the poem, the cover letter, the logo and the code question: glm-5.3 q 3.33 / u 2.70, deepseek-flash 3.17 /
   2.47, kimi-k3 3.44 / 2.11 (kimi has the best judged quality but loses on a 38 s first word). With one quality
   number per lane, the seat (glm-5.3) wins every standard / checked turn by construction.
3. **Stakes reads high on benign asks** — weather 0.62, trip 0.73, business name 0.59. The weather lookup missed the
   Quick lane's 0.6 stakes ceiling and took 157 s (web_pipe + scrape) instead of ~15 s.

Recommended next steps (owner decisions — not done here):
- Flip `laneChecker` (then `laneFailOpen`) to act fleet-wide after reading `loop_metrics lane_depth` would-act vs
  ran: `scripts/framework-audit/set-lane-depth.js` via `prodq.sh`.
- Make the pick task-aware: a `task_kind` decision (writing / code / analysis / lookup / advice / planning) asked as
  its own purpose (not added to the `turn_plan` batch — that would open a new questionsHash partition and reset its
  readiness), stamped on the answer row; bench rows bucket by it; `model-evidence.ts` reads (spec, kind) before
  (spec, lane). Needs a fresh `model-bench.py` run on the test account (real spend) to populate the buckets.
- Re-pose the `stakes` noul toward real harm ("could a wrong answer seriously harm …") under a new partition, or
  raise `TURN_PLAN_QUICK_STAKES_CEILING` for `needs_live_web` lookups.

## Follow-up (same day — owner: "yes do all of this to make digby more sota")

All three recommendations were built and shipped in one wave (canonical: the 2026-10-20 SOTA wave bullet in
AGENTS.md): lane-based depth for every user (code guards first, then the `set-lane-depth.js` flips), the task-aware
model pick (`task_kind` decision purpose, kind-keyed bench evidence, `modelPickKind` store mode, a kind bench on the
built-in models), and the lookup-conditioned Quick stakes ceiling (instead of re-posing turn_plan's stakes question,
which would have reset its act readiness; the `task_kind` purpose asks a `harm` noul with criteria in parallel so the
re-pose can be measured first).

## Part 2 (same day) — what the paid bench showed as a user, and the bench made trustworthy

**A keyword turned chats into coding sessions.** Three bench chats came back with no recorded leader: the coding
engine had answered them. Every chat is auto-filed into a code-capable user-space project, and the send seam attached
a workspace — permanently converting the chat — whenever the message matched the auto-router's CODE_INTENT keyword
list, which includes bare "fix", "bug", "implement", "branch", "merge", "commit" and "exception". So "fix the grammar:
their going to there house later" got a coding run that answered from an empty scaffold workspace and posted a session
status card under the reply; "how do i fix it" (a React question) got "this workspace is a fresh scaffold — I checked,
there's no React code". The same list matches every webhook frame (its rules text says "delete the branch"), so a
plain chat receiving a webhook was converted on its first fire.

**Shipped:** `platform/workspace-attach-gate.ts`. The keyword is a trigger; the `task_kind` decision (the job type the
turn plan already asks) judges, over the turn plan's own state so the plan's later ask is a free memo hit with the
same answer. A confident non-code verdict keeps the chat a chat; a webhook never converts one; a file name, repo path
or PR still attaches; anything uncertain keeps today's behaviour. Its own store mode (shadow first — the ask runs in
the background and never delays the reply — then act), a kill switch, and tests that fail if the escalation /
project-supervisor guards are removed or the verdict is inverted.

**The bench, made trustworthy.** The task-aware pick needs per-kind quality from a bench, and the first plan had
problems a reviewer found before the money was spent or the scores written:
- a blind three-classifier vote over all 203 kind templates found seven filed under the wrong kind by their GROUP
  (a laptop recommendation as "lookup", "how do i ask my boss for a raise" as "explain") — corrected with per-question
  `kind=` flags, and the four already running in wave A are re-filed with `--relabel` before the ingest;
- ten questions per kind is a thin sample against the pick's switch margin, and a later run replaces a kind bucket —
  so a second wave of 70 NEW questions (77 written and kept only when all three blind voters agreed on the kind) runs
  under the same run id beside the first, with a server-side collision / model-field / title-mode check;
- one transient judge failure would have discarded the whole unattended ingest — the comparative call now retries;
- the default judge pointed at a retired gateway route — re-pinned to `qwen3.6-27b`.

Candidates: glm-5.3 (the seat), deepseek-flash, kimi-k3 (`kimi-k2.6` is stored as kimi-k3; `glm-5.3-flash` is not
offered as a lead). Live since ~08:00Z: `laneChecker` = act for every user — the 08:02Z probes show `plan.source
turn_plan`, no Double Checker on a poem, code or an explanation.

## Part 3 (same day) — the flips are live; what a real user sees now

**Live (all through the ec2-ops runner, each read back):** `laneChecker` act 07:51Z · `laneResearch` act 13:11:57Z ·
`modelPickKind` act 13:45:34Z (after its own gate saw ≥ 8 judged questions in all 7 kinds) · `workspaceAttachGate`
act 13:45:38Z. Bench ingest `mbk1020a`: 419 chats, 401 judged comparatively in 135 groups, 0 failed groups, 2 judge
retries, kind agreement 381 / 20 / 17 (agree / differ / unknown).

**What the bench says, and how far to trust it.** With `qwen3.6-27b` judging, deepseek-flash leads every kind
(code 4.13, writing 4.05, planning 3.9, lookup 3.59, explain 3.57, advice 3.45, analysis 3.32), kimi-k3 is second,
glm-5.3 last. A blind re-judge of 35 questions (two independent passes, same winner on 27 of 35) disagrees: kimi-k3
3.63 (34 firsts) > deepseek-flash 2.74 ≈ glm-5.3 2.63. The qwen judge favours length (deepseek's answers average
3,457 chars, the others ~2,600). So the live switch of standard writing / code / explain turns from glm-5.3 to
deepseek-flash is about quality-neutral and faster to first word (≈ 7 s); kimi-k3 is the real quality leader but
takes ≈ 30 s to its first word — a speed-vs-quality call for the owner. Before trusting kind buckets further, the
judge needs debiasing (length-blind rubric, position-swapped pairs).

**Re-test, 16 cases as a signed-in user (vs this morning):**

| case | lane · team | first word / done | notes |
|---|---|---|---|
| poem for mom | standard · deepseek-flash | 6 s / 8 s (was 14 / 16) | kind writing → kind pick |
| business name | standard · deepseek-flash | 8 s / 135 s | asked one question (options with descriptions) |
| cover letter | standard · deepseek-flash | 8 s / 31 s | opened "complete this time — no truncation" — cross-chat bleed, below |
| logo | standard · deepseek-flash | 18 s / 19 s | answered from another chat's "Happy Tails" brief — bleed, below |
| logo (minimal view) | standard · deepseek-flash | 11 s / 33 s | ask_user option details survive the minimal view |
| code / explain | standard · deepseek-flash | 5–6 s / 6–11 s (was 10–14 / 23–27) | |
| grammar fix / leaky faucet | standard / checked | 5 s / 5 s · 17 s / 63 s | both stayed chats — the attach gate held |
| capital / weather | quick · qwen3.6-27b | 9 s / 10 s · 11 s / 51 s (was 157 s) | weather used the saved location |
| mortgage / medication / trip / phones | checked · glm-5.3 + deepseek-flash | 12–15 s / 93–310 s | slow: web_pipe, below |
| fusion research report | research → council | no answer in 13 min | the council's colleagues restarted at 12 min; web_pipe again |

**Found and fixed — one chat's details leaking into another.** Every ungrouped chat sits in one hidden "Workspace"
project, and the memory pipeline kept a project state for it ("[Project Context — Shared across all chats in this
project]": summary, decisions, entities, open items) plus project "decision" rows — written from every chat, injected
into every other. A fresh "make me a logo" answered from another chat's dog-walking brief; a fresh cover letter
apologised for an earlier chat's cut-off draft; seven bench answers cited "provenance" from unrelated chats. The user
never made a project. Now a plain chat in the user space neither reads nor writes that project's memory — not the
injected blocks, not through the search_memory tool, not at extraction — and no project chat's cross-project blend
pulls the hidden project in (`platform/user-space.service.ts userSpaceChatIsolated`); the Fleet Supervisor's fleet
view still reads it, since coding lanes can live there. Learnings from the user's real
projects still reach an ungrouped chat, labelled with their project; user memory, uploaded files, coding sessions and
supervisors are unchanged. Kill switch `USER_SPACE_CHAT_ISOLATION_DISABLED=1`. A three-lens review found the tool path
and the cross-project blend in the first cut; both are closed. **Live since deploy 04562f96 (15:54Z), re-tested at
16:12Z:** fresh "make me a logo" / "design a logo for me" chats now ask for the brand and direction (options with
descriptions) instead of answering from another chat's brief; a fresh "write me a cover letter" asks for the posting
and highlights. The rows already stored stay — the probe counted 852 decision rows written from chats (or typed coding
turns) across 6 of the 8 hidden spaces, 317 from machine runs, 7 learnings, 7 shared state blobs; nothing reads them
from a plain chat any more, and a purge is an owner call.

**web_pipe is the slow part of every checked and research turn — measured, then fixed.** Across the probes web_pipe
(search → read 4 pages → summarise) took 51–109 s per call while search_engine took 2–28 s. The read-only prod probe
(playbook WPL1020, 12 h) confirmed it: 34 calls, p50 69 s / p90 120 s; 5 (15 %) answered "no parseable organic links"
after a 51 s median; underneath, the direct search tier misses most calls and a gateway answer after a direct miss
takes 56–71 s at the median in its worst classes, and a page whose two fetch tiers both time out takes ~133 s — which
the pipe waited for, since it read the slowest of its 4 pages before summarising. Fixed (`coding/web-pipe.ts`): for
search-derived pages the pipe now moves on once two substantive pages are in, cutting only a page that has been
loading 25 s (45 s for the top result and PDFs) — explicitly requested URLs are always read; an unparseable search is
retried once (bounded at 30 s); every call records its stage timings (`loop_metrics web_pipe_timing`) so the next
audit can see where the rest goes. Kill switches `WEB_PIPE_EARLY_EXIT_DISABLED`, `WEB_PIPE_SERP_EMPTY_RETRY_DISABLED`.

**Then the summary became the slow part — fixed.** The first 19 timed calls after that deploy (playbook WPT1020)
split the time: search p50 11.5 s, page reads p50 17 s (p90 37 s; the cut fired twice), storing 4 s — and the closing
summary p50 47 s, p90 and max at its 60 s limit, so at least one call in ten fell back to a bare list of sources. The
summary model writes about 30 tokens a second and was asked for up to 1,400 tokens. It now writes at most 300 words
(800-token cap — the full page text stays searchable through search_memory) and runs alongside the store instead of
after it; its search_memory hints sit in a final section that is removed when nothing was stored. Kill switch
`WEB_PIPE_FAST_DIGEST_DISABLED`.
Read back on prod (14 new calls vs 23 before): the whole web read went from 81 s to 61 s at the median, the summary
from 45 s to 37 s (60 → 46 s for the slowest tenth) and no summary hit the 60 s limit (3 of 23 did before). Still slow
for ~1,460 characters — a direct probe showed why: the summary model (`qwen3.6-27b`) silently reasons for 1,400–2,100
tokens before writing, 25–36 s per call; with thinking switched off the same summary takes 5–7 s at the same length.
Digby already switched it off for its background tasks but not for the summary, Helper workers and the Quick lane's
model (which is documented as "thinking off"). Fixed; kill switch `FAST_SEAT_QWEN_THINKING_OFF_DISABLED`. The Digby
Kids model reasons the same way (12–17 s before its first word) — left as is, a product decision.

**Research councils timed out by construction — fixed.** The same probe found only 3 research turns in 7 days, but
every colleague dispatch timed out twice: a council colleague ran on a 30-minute limit while the lead waits 12 minutes
per dispatch (then 6 on the retry), so a thorough colleague always outlived the wait and its findings arrived late or
not at all — the fusion report took 35.7 minutes. Colleagues (and their clones) now get a deadline that fits inside each
attempt's wait (9 minutes, 3 on the retry), so their final report lands in time; the lead keeps its 40-minute limit.
Kill switch `COUNCIL_PRESET_COLLEAGUE_FIT_DISABLED`.

**Also seen:** one bench answer from deepseek-flash leaked a tool-planning line ("[SEND_EMAIL is not needed here]");
one glm-5.3 answer carried a garbled character.

## Part 4 (same day) — owner decisions, the judge, research without a clock, dropped streams

**Owner decisions:** keep the 852 legacy user-space memory rows (nothing reads them from a plain chat any more); keep
deepseek-flash as the standard-turn model; fix the benchmark judge; deep research gets no time limit.

**Why a connection dropped.** The trip question's stream was reset at 207 s by the test harness's own network
proxy, not by Digby: no deploy was running, Digby was sending progress every 8 seconds, it finished the answer on
the server anyway, and the proxy logs tunnel shutdowns ("server_draining"). A re-run of all six long questions
(one streaming 300 s) dropped nothing. Real users could still lose a live answer in a few ways, now fixed: a guest
(not signed in) could not reconnect at all; reconnecting to the other web server showed only the end of a long
answer; nothing recorded drops. Guests now reconnect like signed-in users, the cross-server replay keeps long
answers whole, the keep-alive starts at once, the page resyncs when the network comes back, and every drop and
resume is counted.

**The benchmark judge.** The old judge was one small model, asked to reward "the right length", shown each question
in one fixed order, and a ranking it cut short was filled in by position. The new judge is a panel that never
scores its own model family, rotates every answer through every position, treats a partial ranking as a failed vote,
is told length and formatting are not quality, and scores answers by head-to-head wins so a skipped judge cannot
tilt the result. It reports how much it still favours length and position. It has not been allowed to change live
model picks yet (deepseek-flash stays); its numbers are reported first.

**Deep research without a clock.** The research council used to stop at 40 minutes (its helpers at 9, a Dig-deeper
council at 15). It now runs until the research is done; the only stop is a model that stops responding for 10
minutes (it is retried first) or one stuck repeating its own reasoning. The lead waits for helpers that are still
working, late findings are posted as they arrive, the wait shown to the user says "as long as it needs", and a
deploy gives a still-working council up to 10 more minutes before handing it over.

### Part 4 — integration review of the merged wave

A cross-branch review (9 agents, per-finding verifiers) of the three merged branches confirmed two defects and one nit, all fixed with tests before the push to main:

- **A council model the lead gave up on wrote into the next turn.** With no wall clock, a colleague given up on keeps running (its late report still posts). Its live events were routed by the chat's run key, so once a follow-up started on the same chat they showed under the follow-up's answer, entered its Redis mirror (a viewer on the other server then saw a foreign run marker and its stream ended early) and counted as its drain progress; Stop on the follow-up also killed the straggler and lost its finding. Fix: `live-runs.ts bindLiveRun` — the detached chat run writes, notes progress and reads Stop through a handle on its own run, silent once that run finished or was replaced.
- **A stalled stream was treated as a dead host.** The stall watchdog's error said `ETIMEDOUT`, which the lead-seat-unreachable lane reads as a connection failure after one retry — it moved a custom-endpoint colleague onto glm-5.3 for the rest of the run. Fix: the stall error is `ESTALL`, retried by the transient lane only.
- **Nit:** the Dig-deeper research chip promised "as long as it needs" even with `RESEARCH_NO_WALL_CLOCK_DISABLED=1`; it now says "about 20 minutes" while the clock is back.

Refuted (with evidence): the drain-status / late-addendum deploy window (pre-existing, narrowed by this wave), the 3300 s per-host deploy bound (a 1500 s drain fits with ~11 min to spare on 242 measured host phases), the bench runbook drift and the judge-v2 workflow default (both unchanged by the merge; the workflow always applies a NEW run id, the `mbk1020a` re-ingest stays a dry `prodq.sh` run).

### Part 4 — live verification (deploy 3194, main 57a39589)

The wave shipped in deploy 3194 (A/B live 22:57:18Z, box C 23:01Z); 3189 was coalesced away by later pushes.

- Health OK. Signed-in L2 ("how do I fix a leaky kitchen faucet") completed in 25.8 s with the Double Checker pill.
- Guest reconnect: a guest stream cut after 8 s and reattached through `GET /session/:id/stream` replayed 172 events through `complete`; the `complete.finalText` equals the stored answer (`corrected: true` — the Double Checker revised it, so the replayed draft chunks differ from the final, which the client swaps in). The route answers 404 to a signed-in caller, 400 to a malformed id and a clean `complete {interrupted}` for an unknown session.
- Qwen Helper thinking-off: the digest step of each web_pipe in that run took 8–11 s (p50 37 s before the fix).
- Open product item, not from this wave: the same guest turn ("compare the three best-reviewed budget e-bikes in Canada …", lane `checked`) took 639 s — the lead made ~12 web calls until its final-turn deadline at 8:24, each web_pipe ~60 s (search ~22 s, scrape ~30 s, digest ~10 s).
- Ops note: the ec2-ops diagnostics' psql sections are refused by RDS on every run (run 422 before this wave too); the app's own database path is unaffected.

### Part 4 — judge v2 validated on a fresh bench (2026-10-21)

`mbk1020a` could not be re-judged: its chats were cleaned up after its first ingest (the dry re-ingest found 0 chats — it was never killed by a deploy, as first assumed). A fresh two-wave kind bench `mbv1021a` (glm-5.3 / deepseek-flash / kimi-k3 on the test account; 21 usable questions across the 7 kinds — q12's answers carry no lead stamp, q16 had one answer) was judged three ways, none of it applied:

| Judge | kimi-k3 | glm-5.3 | deepseek-flash | Order |
|---|---|---|---|---|
| Blind Claude panel (gold; 2 passes, shuffled labels) | 3.33 | 3.19 | 2.48 | kimi > glm > deepseek |
| Judge v2 (panel qwen3.6-27b + deepseek-flash, family-excluded, Latin-square) | 3.30 | 2.94 | 2.76 | **same as gold** |
| Judge v1 (single qwen3.6-27b) | 2.64 | 3.09 | 3.27 | **inverted** |

- Per question, v2 agrees with the panel at Kendall τ 0.32 (top-1 10/21); the panel agrees with itself across passes at τ 0.56 (top-1 15/21) — v2 is about half as consistent with the panel as the panel is with itself, but it gets the overall order right where v1 reverses it.
- Length bias is gone: under v2 the longest answer won 27 % of questions against a 33 % chance rate (length ρ −0.09); the panel picked the longest 24 %.
- By kind both v2 and the panel put deepseek-flash first on planning and lookup and kimi-k3 first on writing and analysis; they disagree on code and advice (2–3 questions each — too few to read).
- Speed (bench, lead seat): deepseek-flash ttft p50 6.1 s, glm-5.3 11.0 s, kimi-k3 37.2 s.
- Not applied: the owner keeps deepseek-flash as the standard pick, and an `--apply` would move kind-keyed picks. The 69 bench chats stay on the test account until that is decided (`model-bench.py --cleanup-run mbv1021a` removes them).

