#!/usr/bin/env python3
"""
model-bench.py — OFFLINE lead-model benchmark through the REAL production chat pipeline (2026-10-04).

The decision model will pick ANY open model per task instead of the fixed "Digby" lead seat, and the owner's rule is
NO live exploration on real users — so each candidate is measured here, on the canonical prod TEST account only
(AGENTS.md "Canonical prod test account"; never register accounts, never use another one), by replaying the SAME
realistic questions (scripts/e2e/human_corpus.py, filled with a seeded rng, WITHOUT the human noise — identical text
for every model) through the production SSE stream with the per-chat lead override:

  for each question q, for each model (order rotated per question so time-of-day drift and run order hit every
  model equally):
    POST /crossmodel/chats {title: "model-bench <runId> q<idx> <spec>"}
    PUT  /crossmodel/chats/:id {leadModel: spec}          (validated server-side; a refusal is recorded, no stream)
    GET  /crossmodel/stream?message=…&mode=auto           (the query suite's Api.stream — paced ≤ 20 starts / 10 min)
    GET  /crossmodel/chats/:id                            → the answer row: metadata.models.digby.modelUsed (the
         model that ACTUALLY led — the Quick lane may divert a quick question to its own model: forced=false),
         metadata.depth.turnPlan.lane, metadata.ux.ttftMs / completionMs

Output: JSONL (one record per question × model) + a markdown summary per model. The chats are KEPT by default — the
ingest (scripts/framework-audit/model-bench-ingest.js, run in the backend container via prodq.sh) reads them, ranks
each question's answers blind with the judge v2 panel (length-blind rubric, each judge ranks only other model families,
K position-rotated ballots per judge for K answers — BENCH_JUDGE_PANEL) and writes the scorecard the picker reads. `--cleanup-run <runId>`
deletes every chat of a run afterwards. Runbook: docs/MODEL_BENCH.md.

COSTS REAL MONEY: N questions × M models real model runs (a question the turn plan routes to research can run a
council). The stream limiter is 25 requests / 10 min per IP — the pacer keeps ≤ 20 starts per rolling 10 minutes,
so 20 questions × 4 models ≈ 40 min minimum.

Usage:
  DIGBY_E2E_EMAIL=claudebot@digby.ai DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py \\
      --models glm-5.3,deepseek-flash,cql-litellm:api-optimize-alibaba-qwen3.8-flash --n 12 --seed 7 --run-id mb1004a
  python3 scripts/e2e/model-bench.py --dry-run --models glm-5.3,deepseek-flash --n 12 --seed 7   # the plan, no network
  python3 scripts/e2e/model-bench.py --self-test                                                  # pure checks
  DIGBY_E2E_EMAIL=... DIGBY_E2E_PASSWORD=... python3 scripts/e2e/model-bench.py --cleanup-run mb1004a [--dry-run]
Options: --groups lookup,howto,…  --kinds writing,code  --per-kind 10  --concurrency 2  --case-timeout 900  --settle 300  --out x.jsonl  --report x.md
         --drop-refused (continue without a model the server refuses as a lead)  --base https://digby.ai/api
         --question-set corpus|tools|mixed (roster 2026-10-06 C-2; default corpus = the human corpus only, unchanged):
           tools = only TOOL_CORPUS (questions that NEED live web tools before the answer — real turns make 1–3 web
           calls, the corpus mostly none, so a corpus-only bench under-predicts real first-word latency); mixed = both,
           stratified together.
         --lanes quick,standard,checked,tools (question FAMILIES aimed at a lane — LANE_GROUPS; a union with --groups;
           `tools` pulls TOOL_CORPUS in even under --question-set corpus). The lane a row is filed under is still the
           answer's own turn-plan lane (metadata.depth.turnPlan.lane), never the family it was drawn from.
         Every record carries web_tool_calls (the LEAD's web tool calls on the stream — label 'Digby'; the ingest
         counts the same from the answer row's parts) and the summary a web-tools p50 column.
         --kinds writing,code,… (TASK KINDS, 2026-10-20 — the task-aware pick's vocabulary, KINDS below = the TS leaf
           platform/task-kind.ts TASK_KINDS): question families by the JOB they ask for (GROUP_KIND, the twin of
           BENCH_GROUP_KIND); a union with --groups / --lanes; pulls the bench-only KIND_CORPUS (and the tool set) in
           (question set → kinds) and lets `code` questions run when `code` is asked for (SKIP_FLAGS skips them
           otherwise). --per-kind K = K questions PER kind (stratified across that kind's groups, interleaved across
           kinds; all kinds when --kinds is absent; replaces --n; not combinable with --groups / --lanes).
           A KIND run's titles (--kinds or --per-kind given) carry the question's kind as a trailing `k:<kind>` token
           (`model-bench <runId> q<idx> <spec> k:<kind>`) so the ingest files each row's quality under its kind
           (models[spec].kinds in the scorecard). A default / --groups / --lanes run writes PLAIN titles exactly as
           before (2026-10-20 review: a routine refresh's 1–4 rows per kind must never become title-keyed kind
           buckets that replace the deep ones a dedicated kind run built; the scorecard merge also keeps a deep kind
           bucket against a thin one). Every record still carries the question's kind for the local summary; the
           answer's own classified kind (metadata.depth.turnPlan.taskKind.kind) is recorded as plan_kind and the
           report prints how often the two agree.
         The GitHub workflow .github/workflows/model-bench.yml (workflow_dispatch only) runs this + the ingest.
Exit: 0 = ran, 1 = every stream failed, 2 = usage / login / account / refused-model error.
"""

import argparse
import json
import os
import random
import re
import sys
import threading
import time
import urllib.error

sys.dont_write_bytecode = True  # importing the suite must not leave __pycache__ in the repo

# The live suite's Api / Pacer / open_with_retry / find_answer / answer_facts (and its human corpus), loaded from this
# script's own directory — the bench is the suite's transport with a different question plan, never a copy of it.
import importlib.util as _ilu
_qs_spec = _ilu.spec_from_file_location('query_suite', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'query-suite.py'))
qs = _ilu.module_from_spec(_qs_spec)
_qs_spec.loader.exec_module(qs)
hc = qs.human_corpus

TITLE_PREFIX = 'model-bench'
# The one account the bench may run on against prod (backend twin: model-bench-scorecard.ts MODEL_BENCH_ACCOUNT_EMAIL).
BENCH_ACCOUNT = 'claudebot@digby.ai'
RUN_ID_RE = re.compile(r'^[A-Za-z0-9._-]{1,64}$')
# The `k:<kind>` token is OPTIONAL and STRICT (lowercase letters only) — 'model-bench r1 q1 glm 5.3' still never parses.
TITLE_RE = re.compile(r'^model-bench (\S+) q(\d+) (\S+)(?: k:([a-z]+))?$')
# Deliberately vague asks are never comparable lead-quality questions; code answers are skipped too UNLESS a kind run
# asks for the `code` kind (--kinds code / --per-kind), where every model is ranked on the same code task.
SKIP_FLAGS = {'code', 'vague'}
PACER_STARTS, PACER_WINDOW_S = 20, 600
# The judge v2 panel the end-of-run hint names (2026-10-20; the ingest's default — model-bench-ingest.js DEFAULT_JUDGE_PANEL —
# is the same: open, non-frontier, distinct families, safe as non-streaming calls). Each judge ranks only the answers of
# OTHER model families, so a candidate of a judge's own family is ranked by the rest of the panel. The single qwen judge
# this replaced rewarded length; `--judge-version v1` on the ingest restores it.
BENCH_JUDGE_PANEL = 'qwen3.6-27b,deepseek-flash'
# Attributions that never reached a model (the server refused the lead pick / the harness could not set up the chat).
NOT_SENT = {'refused', 'harness'}
# Web tools whose calls come before the first answer word (twin of model-bench-scorecard.ts BENCH_WEB_TOOL_NAMES).
WEB_TOOL_NAMES = {'search_engine', 'scrape_as_markdown', 'scrape_as_html', 'scrape_batch', 'browser_task', 'web_pipe', 'youtube_pipe'}
# The stream label of the LEAD's tool calls (chat-agent SEAT_LABELS.lead); 'coding' = the coding harness's own frames.
LEAD_TOOL_LABELS = {'Digby', 'coding'}
QUESTION_SETS = ('corpus', 'tools', 'mixed', 'kinds')
TOOLS_GROUP = 'tools'

# ── TASK KINDS (2026-10-20) — the job a question asks for ───────────────────
# The pinned twins of backend/src/modules/crossmodel/platform/task-kind.ts: KINDS == TASK_KINDS (same ORDER) and
# GROUP_KIND == BENCH_GROUP_KIND (every bench-eligible group → exactly one kind). Both the self-test (parsing the TS
# leaf) and a backend jest test (model-bench-kind-twins.test.ts, parsing THIS file) fail when they drift.
KINDS = ('writing', 'code', 'analysis', 'lookup', 'advice', 'planning', 'explain')
GROUP_KIND = {
    'writing': 'writing', 'paste': 'writing', 'lang': 'writing',
    'code': 'code',
    'math': 'analysis', 'opinion': 'analysis', 'complex': 'analysis',
    'lookup': 'lookup', 'trivia': 'lookup', 'news': 'lookup', 'local': 'lookup', 'shopping': 'lookup', 'tools': 'lookup',
    'health': 'advice', 'money': 'advice', 'advice': 'advice', 'compare': 'advice',
    'plan': 'planning',
    'explain': 'explain', 'howto': 'explain', 'homework': 'explain', 'cooking': 'explain',
}
KIND_GROUPS = {k: tuple(sorted(g for g, kk in GROUP_KIND.items() if kk == k)) for k in KINDS}


# The stratum a RE-FILED entry (a kind= flag naming another kind than its group's) samples in: its new kind's home
# group. As a stratum of its own (its original group) a re-filed entry was drawn in ~every --per-kind run (2026-10-20
# review); inside the home group it is drawn at that group's rate. Every value is a group of that kind (self-test).
KIND_HOME_GROUP = {'writing': 'writing', 'code': 'code', 'analysis': 'complex', 'lookup': 'lookup', 'advice': 'advice',
                   'planning': 'plan', 'explain': 'explain'}


def question_kind(group, flags=()):
    """The kind a question is filed under: a `kind=<k>` flag on the entry (a mixed group — `lang` holds a translation,
    a grammar question and a lookup asked in Spanish) wins over the group's default GROUP_KIND. Pure."""
    for f in flags or ():
        if isinstance(f, str) and f.startswith('kind='):
            k = f.split('=', 1)[1]
            if k in KINDS:
                return k
    return GROUP_KIND.get(group)


def kind_stratum(group, kind):
    """The sampling stratum of an entry inside its kind: its group, or the kind's home group when the entry was
    re-filed there by a kind= flag (KIND_HOME_GROUP). Pure."""
    return group if GROUP_KIND.get(group) == kind else KIND_HOME_GROUP.get(kind, group)

# ── the TOOL-USING question set (roster 2026-10-06 C-2) ─────────────────────
# What a person types when the answer genuinely needs the live web BEFORE the first word: current prices / rates /
# schedules / opening hours / news / releases / local events — some answered from one search, some needing that search
# plus reading one page. Same (group, template, flags) shape as human_corpus.CORPUS; slots from human_corpus.SLOTS.
# Kept HERE (not in human_corpus.py) so the live query suite's seeded samples never change.
TOOL_CORPUS = [
    (TOOLS_GROUP, "what's the weather looking like in {city} this weekend, do i need an umbrella", {'web'}),
    (TOOLS_GROUP, "what time do the {league} play tonight and what channel is it on", {'web'}),
    (TOOLS_GROUP, "what are {store}'s hours today in {city}", {'web'}),
    (TOOLS_GROUP, "how much is a litre of regular gas in {city} right now", {'web'}),
    (TOOLS_GROUP, "convert 250 using today's {cur} rate", {'web'}),
    (TOOLS_GROUP, "what did the bank of canada do with interest rates at its last announcement", {'web'}),
    (TOOLS_GROUP, "any good concerts or events in {city} this weekend", {'web', 'multi'}),
    (TOOLS_GROUP, "what's the latest stable version of python and what's new in it", {'web', 'multi'}),
    (TOOLS_GROUP, "are flights out of {city} delayed today because of weather", {'web'}),
    (TOOLS_GROUP, "how did the {league} do in their last three games", {'web'}),
    (TOOLS_GROUP, "how much is an air fryer at {store} right now, any on sale", {'web'}),
    (TOOLS_GROUP, "what's the newest iphone and when did it come out", {'web'}),
    (TOOLS_GROUP, "give me the top tech news headlines today in a few bullets", {'web', 'multi'}),
    (TOOLS_GROUP, "were there any recalls on baby car seats in canada this month", {'web'}),
    (TOOLS_GROUP, "what's the minimum wage in ontario right now and when does it go up next", {'web'}),
    (TOOLS_GROUP, "what's the uv index in {city} today, do i need sunscreen", {'web'}),
    (TOOLS_GROUP, "is the cn tower open today and how much are tickets", {'web'}),
    (TOOLS_GROUP, "what's the current price of an ounce of gold in canadian dollars", {'web'}),
]

# ── the KIND question set (2026-10-20) ──────────────────────────────────────
# Bench-only questions that fill the kinds the human corpus leaves thin (it holds 1 askable code question, 4
# planning ones), so every kind has ≥ 10 templates and a kind run can rank every candidate on the same jobs. Written
# the way people actually type them; every one is a real deliverable a judge can rank (no vague asks, nothing that
# needs a private account). Same (group, template, flags) shape; groups are human_corpus groups (GROUP_KIND maps
# them). Kept HERE, not in human_corpus.py, so the live query suite's seeded samples never change. Code entries are
# flagged `code` and run only when the `code` kind is asked for.
KIND_CORPUS = [
    # code — real programming tasks
    ('code', "write me a python function that checks if a string is a palindrome, ignore spaces and punctuation", {'code'}),
    ('code', "bash one liner to find the 10 biggest files in a folder incl subfolders?", {'code'}),
    ('code', "can you write a debounce function in javascript and explain when i'd actually use one", {'code'}),
    ('code', "this query is slow: SELECT * FROM orders WHERE YEAR(created_at) = 2024. how do i get it to use the index on created_at", {'code'}),
    ('code', "how do i read a huge csv in python (like 8gb) without running out of memory", {'code'}),
    ('code', "regex for canadian postal codes like K1A 0B1, the space should be optional", {'code'}),
    ('code', "is there a bug here?\n\nfor i in range(len(items)):\n    if items[i] == target:\n        items.remove(items[i])", {'code'}),
    ('code', "how do i undo my last git commit but keep my changes", {'code'}),
    ('code', "write a dockerfile for a small node/express app, i want the image as small as possible", {'code'}),
    ('code', "my react component re-renders every time i type in an input and it's getting laggy, how do i fix it", {'code'}),
    # planning — a plan / schedule as the deliverable
    ('plan', "i want to be conversational in spanish in 6 months before a trip, i've got like 30 min a day. make me a weekly study plan", {'multi'}),
    ('plan', "help me plan my sister's 30th, about 20 people at our place, budget around $600", {'multi'}),
    ('plan', "we move apartments in 3 weeks. what should i be doing each week so it's not total chaos", {'multi'}),
    ('plan', "put together a 5 day gym split for me, i'm intermediate and mostly want to build muscle", {'multi'}),
    ('plan', "plan a one week road trip starting from {city} with about 4 stops, we're bringing our dog", {'multi'}),
    ('plan', "i have 10 weeks to finish my master's thesis and the lit review is half done. break it into a realistic schedule", {'multi'}),
    ('plan', "sleepover for six 8 year olds, science theme. need activities, food and a rough timeline for the night", {'multi'}),
    # analysis — reasoning over numbers, arguments, a structured breakdown
    ('math', "a car loses about 15% of its value a year. what's a $40k car worth after 5 years? show the math", set()),
    ('math', "what are the odds of rolling at least one six if i roll a die four times", set()),
    ('math', "option A is a $5k raise now, option B is a 4% bonus on my $95k salary every year. which is more money over 3 years", set()),
    ('opinion', "is it ethical to eat meat? give me the strongest case on both sides, not a dodge", set()),
    ('opinion', "was daylight saving time ever actually worth it or is it just habit at this point", set()),
    ('complex', "break down why housing got so expensive in canada over the last 20 years, the main factors and how much each one matters", {'multi'}),
    ('complex', "we're a 50 person startup deciding between fully remote and hybrid. lay out the tradeoffs in a structured way", {'multi'}),
    # writing & creative — names, a logo brief, a toast, a rewrite, fiction
    ('writing', "need 10 name ideas for my little bakery, mostly sourdough and cinnamon buns, something cozy but not cheesy", set()),
    ('writing', "write a short brief i can send a designer for a logo for my dog walking business, Happy Tails. style, colours, vibe", set()),
    ('writing', "write a 1 minute toast for my best friend's wedding, funny but not mean, we've been friends since grade 3", set()),
    ('writing', "make this sound professional: hey guys the report is late again sorry, we'll get it to you tomorrow probably", set()),
    ('writing', "write the first 150 words of a short story about a lighthouse keeper who finds a phone that's still ringing", set()),
    # ── 2026-10-20 wave B: a second set per kind (authored + adversarially critiqued, then a BLIND 3-voter kind
    #    classification kept only unanimous ones — 77/77) so a run can reach ~20 judged answers per kind (--continue-from).
    # planning (wave B)
    ('plan', "i have 5 finals in 12 days (calc, chem, bio, psych, english). make me a day by day study schedule that won't totally burn me out", {'multi'}),
    ('plan', "hosting christmas dinner for 12, the turkey's 18 lbs and i only have one oven. give me a timeline for the day so everything is hot at 5pm", {'multi'}),
    ('plan', "getting married next august in nova scotia, around 90 guests, nothing booked yet. what should we be doing month by month from now til the wedding", {'multi'}),
    ('plan', "we just brought home {dog}, a 10 week old lab puppy. week by week training plan for the next 2 months pls - crate, potty, leash, sit/stay", {'multi'}),
    ('plan', "starting a new job as a project coordinator in 2 weeks. help me put together a 30/60/90 day plan so i make a good impression", {'multi'}),
    ('plan', "i've got one 4x8 raised bed in calgary. plan out what to plant and when, april through september, so i get veggies all summer", set()),
    ('plan', "my dad is 70 and wants to get stronger but has a bad left knee. put together a 3 day a week routine he can do at home with no equipment", {'stakes'}),
    ('plan', "9 weeks of summer break, both kids (7 and 10) home and i work from home. help me plan a daily routine plus a theme for each week so they're not on screens all day", {'multi'}),
    ('plan', "10 days in japan in april, flying into tokyo and out of osaka. we like hiking, food and temples, not really nightlife. day by day itinerary pls", {'multi'}),
    ('plan', "want to declutter my whole house in a month - 3 bed 2 bath. i can do maybe 45 min on weekdays and a few hours on weekends. schedule it room by room", {'multi'}),
    ('plan', "i want to go from zero to landing a junior data analyst job in a year, about 10 hrs a week. map out what to learn month by month (python, sql, excel, portfolio etc)", {'multi'}),
    ('plan', "launching my etsy candle shop on nov 15. need a 4 week countdown plan covering photos, listings, instagram, packaging, all of it", {'multi'}),
    ('plan', "me and my partner have saturday and sunday free in {city} this weekend. plan both days around concerts or events that are actually on", {'multi', 'web'}),
    ('plan', "going to potty train my 2.5 year old over the long weekend. can you plan out the 3 days, roughly hour by hour", {'multi'}),
    ('plan', "first baby due in february. make me a month by month list of what to get done before then - nursery, car seat, EI parental leave paperwork, hospital bag, etc", {'multi', 'stakes'}),
    # writing & creative (wave B)
    ('writing', "write a polite but firm email to my landlord, the dishwasher's been broken 3 weeks and i've texted him twice already with no reply", set()),
    ('writing', "can u write a short resignation letter giving 2 weeks notice? leaving my job at {store} on good terms and i want to thank my manager", set()),
    ('writing', "write a thank you card message for my son's grade 2 teacher, she really helped him get into reading this year. 3-4 sentences", set()),
    ('writing', "need 5 catchy slogans for my kid's hockey team bottle drive this saturday, short enough to fit on a poster", set()),
    ('writing', "write a linkedin post saying i finally passed my CPA exam after 2 tries. humble, not cringe, max 2 hashtags", set()),
    ('writing', "write a limerick about waiting for the TTC streetcar in a snowstorm", set()),
    ('writing', "write an etsy product description for a hand-knit merino wool toque, about 80 words, cozy vibe, mention it's made in nova scotia", set()),
    ('writing', "write a bedtime story for my 5 year old about a raccoon who wants to be a firefighter, around 300 words, ends with everyone falling asleep", set()),
    ('paste', "turn these notes into a proper email to my team pls: meeting moved to thurs 2pm, room 4b, bring your q3 numbers, pizza provided", set()),
    ('paste', "rewrite this so my 10 year old can understand it, keep it short:\n\n{paragraph}", set()),
    ('paste', "can you cut this down to about half the length but keep the main ask, it's going to our new client:\n\nHi Dana, I hope this message finds you well and that your week is off to a great start. I wanted to reach out regarding the onboarding session we discussed during our call last Tuesday. As you may recall, we talked about getting your team set up on the new dashboard before the end of the month, and I wanted to follow up to see if you had a chance to look at the calendar options I sent over. We have a few slots available next week, specifically Tuesday afternoon, Wednesday morning, and Thursday at 2pm Eastern. The session usually takes about 90 minutes, and it works best if everyone who will be using the dashboard can attend, since we cover permissions, reporting, and exports. If none of those times work, please let me know and I will do my best to find something that fits better for your team. Also, if you could send me the list of attendees ahead of time, that would help us set up their accounts in advance. Looking forward to hearing from you. Best regards, Sam", set()),
    ('lang', "translate to spanish for my airbnb host: we'll arrive around 11pm, is self check-in possible? thanks so much!", set()),
    ('lang', "schreib mir bitte eine kurze, lockere einladung an meine nachbarn zum grillabend am samstag ab 18 uhr", set()),
    ('lang', "écris-moi un petit mot pour remercier ma voisine qui a gardé mon chat pendant nos vacances à gaspé", set()),
    # code (wave B)
    ('code', "excel formula to pull the price from Sheet2 using the product code in A2, and show 'not found' instead of #N/A when there's no match", {'code'}),
    ('code', "write me a bash script that backs up my ~/Documents folder to an external drive mounted at /mnt/backup, with today's date in the folder name, and the crontab line to run it every night at 2am", {'code', 'multi'}),
    ('code', "write a typescript type guard that checks if an unknown value is a User object with id (number) and email (string)", {'code'}),
    ('code', "write a tiny go http server with a /health endpoint that returns json status ok, listening on port 8080", {'code'}),
    ('code', "getting TypeError: Cannot read properties of undefined (reading 'map') when my react page first loads. the data comes from a fetch inside useEffect. how do i fix it", {'code'}),
    ('code', "postgres: employees table has id, name, manager_id (points to another employee). how do i get everyone under a given manager including indirect reports, all the way down", {'code'}),
    ('code', "java - easiest way to turn a List<String> into one comma separated string but skip nulls and empty strings? on java 17", {'code'}),
    ('code', "python script to rename all the jpgs in a folder to the date they were taken from the exif data, like 2024-07-15_001.jpg, numbering if there's more than one per day", {'code'}),
    ('code', "pandas question: my sales dataframe has a date column stored as strings like 2024-03-15, a province column and an amount column. how do i get total and average sales per month per province", {'code'}),
    ('code', "my python script works fine when i run it by hand but does nothing from crontab, it's supposed to write to a log file. what's usually the cause and how do i debug it", {'code'}),
    ('code', "can you convert this to async/await pls\n\nfetch(url).then(r => r.json()).then(data => render(data)).catch(e => showError(e))", {'code'}),
    ('code', "i accidentally committed my .env file with api keys 3 commits ago and already pushed to github. how do i remove it from the history completely", {'code', 'stakes'}),
    ('code', "write pytest tests for this, incl the edge cases:\n\ndef calc_tax(amount, province):\n    rates = dict(ON=0.13, AB=0.05, BC=0.12)\n    return round(amount * rates[province], 2)", {'code'}),
    ('code', "css: my sticky header stops sticking as soon as i put it inside a wrapper div that has overflow: hidden. how do i keep it sticky without breaking the layout", {'code'}),
    # advice (wave B)
    ('advice', "my coworker keeps presenting my ideas as hers in team meetings. i'm pretty junior and don't want to come off petty, how should i handle it", set()),
    ('advice', "my mom wants to move in with us after my dad passed. we've got two kids and a 3 bedroom place in calgary. how do we bring this up as a family without anyone feeling pushed out", set()),
    ('advice', "my best friend asked me to be her maid of honour but i honestly can't afford the bachelorette trip to vegas. how do i tell her without hurting her, and what could i offer to do instead", {'multi'}),
    ('advice', "i'm 34, thinking about going back to school for nursing. i have a mortgage and a 6 year old and my partner works full time. is this crazy or actually doable?", set()),
    ('compare', "got an offer for 8k more a year but it's fully in office, my current job is hybrid and i really like my team. which would you pick in my shoes", set()),
    ('compare', "should i get a heat pump or just replace my old gas furnace? house is in ottawa, built in 1985, furnace is about 20 yrs old", {'stakes'}),
    ('compare', "kindle or kobo for someone who mostly borrows library ebooks through libby? i read in bed every night", set()),
    ('health', "i keep waking up around 3am and can't fall back asleep, been going on for about a month. what can i try before i bother my doctor", {'stakes'}),
    ('health', "my 8 month old has had a 38.5 fever since this morning but she's still eating and playing. do i need to take her to emerg or is it ok to wait and watch", {'stakes'}),
    ('health', "my knee clicks and aches after runs and i'm training for a half marathon in 6 weeks. should i push through, cut back or fully rest?", {'stakes'}),
    ('money', "just got a 5k bonus. i have about 4k on a credit card at 20% and zero emergency fund. what should i actually do with it", {'stakes'}),
    ('money', "i'm 59, still healthy, have a small workplace pension and some RRSP savings. should i start taking CPP at 60 or hold off till 65?", {'stakes'}),
    ('money', "my parents offered to co-sign my first mortgage in halifax. what should we all think about before saying yes, for me and for them", {'multi', 'stakes'}),
    # explain (wave B)
    ('howto', "how do i bleed a radiator? the one in my bedroom is cold at the top and makes a gurgling sound", set()),
    ('howto', "car battery died in the work parking lot and a coworker has cables. walk me through jump starting it step by step, which clamp goes where", {'multi', 'stakes'}),
    ('howto', "never knit anything before but want to make a basic scarf. how do i cast on and do the knit stitch?", {'multi'}),
    ('howto', "how do you parallel park properly? i always end up like a metre from the curb or hitting the car behind", set()),
    ('explain', "why do my ears pop on a plane? like what's actually physically happening in there", set()),
    ('explain', "can someone explain how the bank of canada raising interest rates is supposed to bring inflation down? i don't get how that connects to grocery prices", set()),
    ('explain', "how does noise cancelling in headphones actually work? is it just really good padding or something else", set()),
    ('homework', "my grade 9 daughter has to solve 2x + 7 = 19 and i forgot how to explain isolating x. can you walk me through it so i can teach her", set()),
    ('homework', "doing a history assignment on confederation in 1867, can u explain why the colonies even wanted to join together in the first place", set()),
    ('homework', "test tmrw on balancing chemical equations and i'm lost. can you explain how to balance H2 + O2 -> H2O step by step", set()),
    ('cooking', "why does my homemade bread keep coming out dense and heavy? using all purpose flour and letting it rise about an hour. what's going on with the yeast", set()),
    ('cooking', "how do i make a dark roux for gumbo without burning it, and how do i tell when it's dark enough", {'multi'}),
    # analysis (wave B)
    ('math', "gas is $1.62/L here and my car does about 7.8 L/100km. what does a round trip montreal to ottawa cost me, its roughly 200km each way", set()),
    ('math', "store marks a jacket up 40% then runs a 25% off sale on it. is the sale price above or below what they paid for it, and by what %", set()),
    ('math', "mortgage of $420k at 4.89% fixed, 25 yr amortization. whats the monthly payment and total interest paid over the whole thing? canadian semi-annual compounding pls", {'multi', 'stakes'}),
    ('math', "ran a 10k in 52:30 this morning. whats my pace per km and per mile, and how long would a half marathon take if i held that pace", {'multi'}),
    ('opinion', "should voting be mandatory in canada like it is in australia? give me the real arguments both ways and where you land", set()),
    ('opinion', "are EVs actually cleaner than gas cars once you count battery mining and how the power grid makes electricity? dont just cheerlead either side", set()),
    ('opinion', "is homework in elementary school worth it or is it mostly busywork? weigh what the evidence actually says tho", set()),
    ('complex', "why did blockbuster die while netflix made it? break down the key decisions and which ones actually mattered most", set()),
    ('complex', "carbon tax vs cap and trade — lay out the tradeoffs on cost to households, actual emissions cuts and politics in a table", {'multi'}),
]

# Question FAMILIES aimed at a lane (--lanes). Approximate on purpose: the lane a row is filed under is the answer's
# own turn-plan lane. Every name is a real human_corpus group (pinned by the self-test); `tools` = TOOL_CORPUS.
LANE_GROUPS = {
    'quick': ('lookup', 'trivia', 'local', 'shopping', 'news'),
    'standard': ('howto', 'writing', 'explain', 'cooking', 'homework', 'plan', 'lang', 'paste'),
    'checked': ('health', 'money', 'advice', 'opinion', 'compare', 'math', 'complex'),
    'tools': (TOOLS_GROUP,),
}


# ── titles / ids (twins of backend/src/modules/crossmodel/platform/model-bench-scorecard.ts) ─────────────────────
def valid_run_id(run_id):
    return isinstance(run_id, str) and bool(RUN_ID_RE.match(run_id))


def default_run_id(now=None):
    return 'mb' + time.strftime('%Y%m%dT%H%M%S', time.gmtime(now if now is not None else time.time()))


def bench_title(run_id, idx, spec, kind=None):
    """`model-bench <runId> q<idx> <spec>[ k:<kind>]` — the ingest selects a run's chats on this exact shape; the kind
    token only for a known kind (anything else writes none). Pure."""
    return f'{TITLE_PREFIX} {run_id} q{idx} {spec}' + (f' k:{kind}' if kind in KINDS else '')


def run_tags_kinds(kinds=None, per_kind=None):
    """Whether a run's chat titles carry the `k:<kind>` token: ONLY a KIND run (--kinds or --per-kind given). A
    default / --groups / --lanes run writes plain titles (2026-10-20 review — its few rows per kind would otherwise
    file title-keyed kind buckets that replace a dedicated kind run's deep ones). Pure."""
    return bool(kinds) or per_kind is not None


def title_kind(q, tag_kinds):
    """The kind a question's chat TITLE carries: the question's kind on a kind run (run_tags_kinds), else None (the
    record still carries the kind for the local summary). Pure."""
    return (q or {}).get('kind') if tag_kinds else None


def parse_bench_title(title):
    """The title's parts; 'kind' ONLY when the title carried a known `k:<kind>` token (an unknown kind still parses,
    without it — the row counts by lane). None for any other title. Pure."""
    m = TITLE_RE.match(str(title or ''))
    if not m or not valid_run_id(m.group(1)) or int(m.group(2)) < 1:
        return None
    out = {'run_id': m.group(1), 'idx': int(m.group(2)), 'spec': m.group(3)}
    if m.group(4) in KINDS:
        out['kind'] = m.group(4)
    return out


def parse_models(raw):
    """'a, b,a' → ['a', 'b'] (order kept, duplicates dropped); a spec with whitespace is refused (ValueError). Pure."""
    out = []
    for s in str(raw or '').split(','):
        s = s.strip()
        if not s:
            continue
        if re.search(r'\s', s) or len(s) > 200:
            raise ValueError(f'bad model spec: {s!r}')
        if s not in out:
            out.append(s)
    return out


# ── the question plan ────────────────────────────────────────────────────────
def question_pool(question_set='corpus'):
    """The entries a question set draws from: corpus = human_corpus.CORPUS (today's bench, unchanged), tools =
    TOOL_CORPUS, mixed = both (corpus first), kinds = the corpus + KIND_CORPUS + TOOL_CORPUS (2026-10-20). Pure."""
    if question_set not in QUESTION_SETS:
        raise ValueError(f'unknown question set: {question_set!r} (one of {", ".join(QUESTION_SETS)})')
    if question_set == 'tools':
        return list(TOOL_CORPUS)
    if question_set == 'mixed':
        return list(hc.CORPUS) + list(TOOL_CORPUS)
    if question_set == 'kinds':
        return list(hc.CORPUS) + list(KIND_CORPUS) + list(TOOL_CORPUS)
    return list(hc.CORPUS)


def lane_groups(lanes):
    """--lanes names → the set of groups they draw from (LANE_GROUPS); an unknown lane raises ValueError. Pure."""
    out = set()
    for lane in lanes or []:
        if lane not in LANE_GROUPS:
            raise ValueError(f'unknown lane: {lane!r} (one of {", ".join(LANE_GROUPS)})')
        out |= set(LANE_GROUPS[lane])
    return out


def kind_groups(kinds):
    """--kinds names → the set of groups they draw from (KIND_GROUPS); an unknown kind raises ValueError. Pure."""
    out = set()
    for kind in kinds or []:
        if kind not in KIND_GROUPS:
            raise ValueError(f'unknown kind: {kind!r} (one of {", ".join(KINDS)})')
        out |= set(KIND_GROUPS[kind])
    return out


def resolve_selection(question_set='corpus', lanes=None, groups=None, kinds=None):
    """(question set, group filter) for a run: --lanes, --groups and --kinds combine as a UNION of groups; a `tools`
    group pulls TOOL_CORPUS in (corpus → mixed); a kind pulls KIND_CORPUS + TOOL_CORPUS in (corpus / mixed → kinds;
    an explicit tools set stays tools). None = no group filter. Pure."""
    wanted = lane_groups(lanes) | set(groups or []) | kind_groups(kinds)
    qset = question_set
    if kinds and qset in ('corpus', 'mixed'):
        qset = 'kinds'
    if TOOLS_GROUP in wanted and qset == 'corpus':
        qset = 'mixed'
    return qset, (wanted or None)


def eligible_corpus(groups=None, question_set='corpus', allow_code=False, asked=None, kinds=None):
    """Entries of the question set the bench may ask: no 'vague' flag, no 'code' flag unless allow_code (a kind run
    that asks for the code kind); never a template an earlier wave of the run already asked (`asked` = its question
    texts — template_asked). Selection: an entry whose group is in `groups` OR whose kind (question_kind — a kind=
    flag wins over the group) is in `kinds`; neither given = every entry. Pure."""
    skip = SKIP_FLAGS - {'code'} if allow_code else SKIP_FLAGS

    def selected(g, f):
        if not groups and not kinds:
            return True
        return bool((groups and g in groups) or (kinds and question_kind(g, f) in kinds))
    return [(g, t, f) for g, t, f in question_pool(question_set)
            if not (set(f) & skip) and selected(g, f) and not (asked and template_asked(t, asked))]


def template_regex(template):
    """A template as a full-match regex over its filled text: the literal text escaped, every {slot} any text. Pure."""
    parts = re.split(r'\{(\w+)\}', template)
    return re.compile(''.join(re.escape(x) if i % 2 == 0 else '.+?' for i, x in enumerate(parts)) + r'\Z', re.S)


def template_asked(template, asked):
    """Whether a template was already asked: one of the `asked` question texts is a fill of it. Pure."""
    rx = template_regex(template)
    return any(rx.match(t) for t in asked)


def read_records(path):
    """A bench --out JSONL → its records. Raises ValueError (unreadable / not JSONL). Pure over the file."""
    out = []
    try:
        with open(path, encoding='utf-8') as fh:
            for line in fh:
                line = line.strip()
                if line:
                    out.append(json.loads(line))
    except OSError as e:
        raise ValueError(f'cannot read {path}: {e}')
    except json.JSONDecodeError as e:
        raise ValueError(f'{path}: not JSONL ({e})')
    return out


def load_prior_waves(paths, run_id):
    """Every earlier wave of THIS run (their --out JSONLs) → {top, asked, specs, tagged, complete, missing, records}.
    top = the highest q idx; asked = the question texts; specs = the models the waves ran; tagged = whether their titles
    carried k:<kind> (a set — a mix is a defect); complete = every q in 1..top has a record for every spec (a wave
    still running, or one cut short, is NOT complete: its chats may exist past its file). Raises ValueError on an
    unreadable file, a record of another run id, or no records. Pure over the files."""
    recs = []
    for path in paths:
        for r in read_records(path):
            if r.get('run_id') != run_id:
                raise ValueError(f'{path}: a record of run {r.get("run_id")!r}, not {run_id!r} — --continue-from extends the SAME run id')
            recs.append(r)
    if not recs:
        raise ValueError(f'{", ".join(paths)}: no records')
    per_q, specs, tagged = {}, set(), set()
    for r in recs:
        if isinstance(r.get('q'), int) and isinstance(r.get('spec'), str):
            per_q.setdefault(r['q'], set()).add(r['spec'])
            specs.add(r['spec'])
        t = parse_bench_title(r.get('title'))
        if t:
            tagged.add('kind' in t)
    top = max(per_q) if per_q else 0
    missing = [q for q in range(1, top + 1) if per_q.get(q) != specs]
    return {'top': top, 'asked': {r['question'] for r in recs if isinstance(r.get('question'), str)}, 'specs': specs,
            'tagged': tagged, 'complete': not missing, 'missing': missing, 'records': recs}


def load_prior_wave(path, run_id):
    """One earlier wave → (its highest q idx, its asked texts). Pure over the file (load_prior_waves)."""
    p = load_prior_waves([path], run_id)
    return p['top'], p['asked']


def load_avoid(paths):
    """--avoid files → the question texts never to ask: a JSON list of strings, or a JSONL whose records carry
    `question` / `text`. Raises ValueError. Pure over the files."""
    out = set()
    for path in paths:
        try:
            raw = open(path, encoding='utf-8').read()
        except OSError as e:
            raise ValueError(f'cannot read {path}: {e}')
        try:
            data = json.loads(raw)
            items = data if isinstance(data, list) else [data]
        except json.JSONDecodeError:
            try:
                items = [json.loads(l) for l in raw.splitlines() if l.strip()]
            except json.JSONDecodeError as e:
                raise ValueError(f'{path}: neither a JSON list nor JSONL ({e})')
        for it in items:
            if isinstance(it, str):
                out.add(it)
            elif isinstance(it, dict) and isinstance(it.get('question') or it.get('text'), str):
                out.add(it.get('question') or it.get('text'))
    return out


def existing_run_facts(titles):
    """The run's chat titles ON THE SERVER → {n, top, specs, tagged} (preflight / other titles ignored). Pure."""
    rows = [t for t in (parse_bench_title(x) for x in titles) if t]
    return {'n': len(rows), 'top': max((t['idx'] for t in rows), default=0), 'specs': {t['spec'] for t in rows},
            'tagged': {'kind' in t for t in rows}}


def continuation_refusal(existing, first_idx, models, tag_kinds, continuing):
    """Why a run may NOT start against the chats its run id already has (None = go). A fresh run onto an existing run
    id, a first q<idx> at or below the server's highest (a title collision — the ingest would rank two questions as
    one), a different model field (ranks from a K-model field are comparable only within it) or a different title
    mode (k:<kind> vs plain) are refused. Pure."""
    if not existing or not existing.get('n'):
        return None
    if not continuing:
        return (f"the run id already has {existing['n']} bench chat(s) (up to q{existing['top']}) — extend it with "
                '--continue-from / --start-idx, or pick a new --run-id')
    if first_idx is not None and first_idx <= existing['top']:
        return (f"q{first_idx} collides with the run's chats on the server (up to q{existing['top']}) — a wave still "
                'running, or one cut short, has chats past its file: wait for it, or pass --start-idx past its plan')
    if existing['specs'] != set(models):
        return (f"model field differs from the run's chats ({', '.join(sorted(existing['specs']))} vs "
                f"{', '.join(sorted(models))}) — ranks are only comparable within one field; use a new --run-id")
    if existing['tagged'] != {bool(tag_kinds)}:
        return "title mode differs from the run's chats (k:<kind> vs plain) — use the same --kinds / --per-kind mode"
    return None


def relabel_plan(records, pool=None):
    """Records whose kind the CURRENT corpus files differently (a kind= correction after the wave ran) →
    [(record, new_kind)]. The template is matched by the record's `template` (exact) else by its text within its
    group (template_regex); a record that matches no unique template is left alone. Pure."""
    pool = question_pool('kinds') if pool is None else pool
    out = []
    for r in records:
        g, text = r.get('group'), r.get('question')
        if not isinstance(text, str):
            continue
        hits = [(gg, t, f) for gg, t, f in pool if gg == g and (t == r.get('template') if r.get('template') else template_regex(t).match(text))]
        if len(hits) != 1:
            continue
        k = question_kind(hits[0][0], hits[0][2])
        if k and k != r.get('kind'):
            out.append((r, k))
    return out


def renumber(questions, offset):
    """Question idx shifted past an earlier wave's last idx (titles stay unique within the run id). Pure."""
    return [{**q, 'idx': q['idx'] + offset} for q in questions]


def sample_questions(n, seed, groups=None, question_set='corpus', allow_code=False, asked=None, kinds=None):
    """n questions STRATIFIED across corpus groups: the group order and each group's entries are shuffled with the
    seed, then one entry per group per round until n (or the corpus) runs out. Each is filled ONCE with the seeded
    rng and never noised — every model gets byte-identical text. Each carries its kind (question_kind: a kind= flag,
    else its group's GROUP_KIND; None outside the map). `kinds` selects by that kind (eligible_corpus). Pure over the
    seed."""
    rng = random.Random(seed)
    by_group = {}
    for g, t, f in eligible_corpus(groups, question_set, allow_code, asked, kinds):
        by_group.setdefault(g, []).append((t, f))
    order = sorted(by_group)
    rng.shuffle(order)
    for g in order:
        rng.shuffle(by_group[g])
    out, seen = [], set()
    while len(out) < n and any(by_group[g] for g in order):
        for g in order:
            if len(out) >= n:
                break
            if not by_group[g]:
                continue
            template, flags = by_group[g].pop()
            text = hc.fill(template, rng)
            if text in seen:
                continue
            seen.add(text)
            out.append({'idx': len(out) + 1, 'group': g, 'kind': question_kind(g, flags), 'flags': sorted(flags), 'text': text, 'template': template})
    return out


def sample_per_kind(per_kind, seed, kinds=None, question_set='kinds', asked=None):
    """per_kind questions for EACH kind (all KINDS when none given): within a kind STRATIFIED across its groups (group
    order + entries seeded-shuffled, one entry per group per round), then INTERLEAVED across kinds (seeded kind order,
    one question of each kind per round) so time-of-day drift hits every kind alike. `code` entries run only when the
    code kind is asked for. A kind with fewer templates than per_kind gives what it has. Filled once, never noised.
    Pure over the seed."""
    kinds = list(kinds or KINDS)
    kind_groups(kinds)  # validates: an unknown kind raises ValueError
    rng = random.Random(seed)
    by_kind = {}
    for g, t, f in eligible_corpus(None, question_set, allow_code='code' in kinds, asked=asked):
        k = question_kind(g, f)
        if k in kinds:
            # A re-filed entry samples inside its kind's home group (kind_stratum), never as a 1-entry stratum.
            by_kind.setdefault(k, {}).setdefault(kind_stratum(g, k), []).append((g, t, f))
    kind_order = [k for k in KINDS if k in by_kind]
    rng.shuffle(kind_order)
    picked, seen = {}, set()
    for k in kind_order:
        groups = by_kind[k]
        order = sorted(groups)
        rng.shuffle(order)
        for g in order:
            rng.shuffle(groups[g])
        out = []
        while len(out) < per_kind and any(groups[g] for g in order):
            for g in order:
                if len(out) >= per_kind:
                    break
                if not groups[g]:
                    continue
                g0, template, flags = groups[g].pop()
                text = hc.fill(template, rng)
                if text in seen:
                    continue
                seen.add(text)
                out.append({'group': g0, 'kind': k, 'flags': sorted(flags), 'text': text, 'template': template})
        picked[k] = out
    questions = []
    while any(picked[k] for k in kind_order):
        for k in kind_order:
            if picked[k]:
                questions.append({'idx': len(questions) + 1, **picked[k].pop(0)})
    return questions


def plan_tasks(questions, models):
    """Interleaved: every model on q1, then q2, … — the model order ROTATES one step per question, so each model is
    first (and last) equally often and drift hits every model alike. Pure."""
    tasks = []
    m = len(models)
    for k, q in enumerate(questions):
        rot = k % m if m else 0
        for spec in models[rot:] + models[:rot]:
            tasks.append({'question': q, 'spec': spec})
    return tasks


def pacing_floor_minutes(streams):
    """The pacer's lower bound on wall time for `streams` starts (≤ 20 per rolling 10 min). Pure."""
    if streams <= PACER_STARTS:
        return 0
    return int(((streams - 1) // PACER_STARTS) * PACER_WINDOW_S / 60)


# ── reading one answer ───────────────────────────────────────────────────────
def bench_facts(msg):
    """The persisted answer row → what the bench records (the suite's answer_facts + ux + the lead card). Pure."""
    facts = qs.answer_facts(msg)
    md = (msg or {}).get('metadata') or {}
    ux = md.get('ux') or {}
    lead = (md.get('models') or {}).get('digby') or {}
    num = lambda v: v if isinstance(v, (int, float)) and not isinstance(v, bool) else None
    return {
        'answered': msg is not None,
        'answer_id': facts['id'],
        'answer_chars': len(facts['content']),
        'model_used': lead.get('modelUsed') or None,
        'lane': facts['lane'],
        'plan_lane': facts['plan_lane'],
        # 2026-10-20: the answer's classified task kind (turnPlan.taskKind.kind) — the ingest's fallback bucket key.
        'plan_kind': facts.get('plan_kind') if facts.get('plan_kind') in KINDS else None,
        'act': facts['act'],
        'preset': facts['preset'],
        'ttft_ms': num(ux.get('ttftMs')),
        'completion_ms': num(ux.get('completionMs')),
        'lead_error': (str(lead.get('error'))[:200] if lead.get('error') else None),
        'tool_errors': facts['tool_errors'],
    }


def attribute(rec):
    """How a record counts for its spec — the twin of model-bench-scorecard.ts attributeBenchRow plus the two
    never-sent states. measured = the spec led; diverted = the Quick lane ran another model (excluded); failed = no /
    empty / errored answer; failover = another model finished the turn (counts against the spec); unverified = an
    answer whose leader is unknown (excluded). Pure."""
    if rec.get('lead_model_error'):
        return 'refused'
    if rec.get('harness_error'):
        return 'harness'
    mu, spec = rec.get('model_used'), rec.get('spec')
    if mu and mu != spec and rec.get('plan_lane') == 'quick':
        return 'diverted'
    if not rec.get('answered') or not rec.get('answer_chars') or rec.get('lead_error'):
        return 'failed'
    if not mu:
        return 'unverified'
    return 'measured' if mu == spec else 'failover'


def lead_web_tool_calls(stream_tools):
    """The LEAD's web tool calls among the stream's [label, name] tool rows (a checker / colleague's own searches are
    not the lead's wait) — roster 2026-10-06 C-2; the ingest counts the same from the answer row's parts. Pure."""
    return sum(1 for row in stream_tools or [] if isinstance(row, (list, tuple)) and len(row) == 2
               and row[0] in LEAD_TOOL_LABELS and row[1] in WEB_TOOL_NAMES)


# ── HTTP: the suite's Api plus two calls ─────────────────────────────────────
def http_error_text(e):
    try:
        raw = e.read().decode('utf-8', 'replace')
    except Exception:
        return ''
    try:
        d = json.loads(raw)
        return str(d.get('error') or d.get('message') or raw)[:300]
    except Exception:
        return raw[:300]


class BenchApi(qs.Api):
    def set_lead_model(self, chat_id, spec):
        """PUT {leadModel} (ONLY that field — a body with a title routes to the rename path and drops leadModel) →
        (the stored canonical spec, None) or (None, the refusal text)."""
        try:
            d = self._req('PUT', f'/crossmodel/chats/{chat_id}', {'leadModel': spec}, timeout=30)
        except urllib.error.HTTPError as e:
            return None, f'HTTP {e.code}: {http_error_text(e)}'
        except Exception as e:
            return None, f'{type(e).__name__}: {str(e)[:160]}'
        stored = ((d or {}).get('data') or {}).get('leadModel')
        if not stored:
            return None, 'the server stored no lead model (response carried no leadModel)'
        return stored, None

    def list_chats_page(self, page, limit=50):
        d = self._req('GET', f'/crossmodel/chats?page={page}&limit={limit}', timeout=60)
        data = (d or {}).get('data') or {}
        return data.get('chats') or [], data.get('pagination') or {}


def preflight(api, run_id, models):
    """Each spec once on a throwaway chat (deleted at once): {spec: (canonical, error)} — a refused spec fails the
    run before any money is spent; an aliased spec (glm-5.2 → glm-5.3) is benchmarked under its canonical id."""
    out = {}
    for spec in models:
        chat_id = None
        try:
            chat_id = api.new_chat(f'{TITLE_PREFIX} {run_id} preflight')
            out[spec] = api.set_lead_model(chat_id, spec) if chat_id else (None, 'could not create the preflight chat')
        except Exception as e:
            out[spec] = (None, f'{type(e).__name__}: {str(e)[:160]}')
        finally:
            if chat_id:
                api.delete_chat(chat_id)
    return out


def run_task(api, pacer, task, run_id, timeout, settle, tag_kinds=False):
    q, spec = task['question'], task['spec']
    title = bench_title(run_id, q['idx'], spec, title_kind(q, tag_kinds))
    rec = {'run_id': run_id, 'q': q['idx'], 'group': q['group'], 'kind': q.get('kind'), 'plan_kind': None, 'flags': q['flags'], 'question': q['text'], 'template': q.get('template'), 'spec': spec,
           'title': title, 'chat_id': None, 'started_at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()),
           'lead_model_error': None, 'harness_error': None, 'errors': [], 'timed_out': False, 'first_chunk_s': None,
           'complete_s': None, 'tools': [], 'tool_calls': 0, 'answered': False, 'answer_chars': 0, 'model_used': None,
           'forced': None, 'lane': None, 'plan_lane': None, 'act': False, 'ttft_ms': None, 'completion_ms': None, 'lead_error': None,
           'web_tool_calls': 0}
    try:
        rec['chat_id'] = api.new_chat(title)
        if not rec['chat_id']:
            rec['harness_error'] = 'could not create the chat'
        else:
            stored, err = api.set_lead_model(rec['chat_id'], spec)
            if err:
                rec['lead_model_error'] = err
            elif stored != spec:
                rec['harness_error'] = f'the server stored lead {stored!r}, not {spec!r}'
    except Exception as e:
        rec['harness_error'] = f'{type(e).__name__}: {str(e)[:160]}'
    if rec['harness_error'] or rec['lead_model_error']:
        rec['attribution'] = attribute(rec)
        return rec
    pacer.wait()
    s = api.stream(q['text'], rec['chat_id'], timeout=timeout)
    # An HTTP 4xx on the stream (the IP limiter's 429, an auth refusal) means no run started — never wait the settle
    # window for an answer that cannot come, and never count it against the model (the ingest skips the chat too:
    # no user row was persisted).
    refused_stream = any(str(e).startswith('HTTP 4') for e in s.get('errors') or [])
    tries = 2 if refused_stream else (max(8, settle // 5) if s.get('timed_out') or s.get('errors') else 8)
    facts = bench_facts(qs.wait_answer(api, rec['chat_id'], tries=tries, delay=5, user_text=q['text']))
    rec.update({'errors': s['errors'], 'timed_out': s['timed_out'], 'first_chunk_s': s['first_chunk_s'], 'complete_s': s['complete_s'],
                'tools': sorted({name for _, name in s['tools']}), 'tool_calls': len(s['tools']),
                'web_tool_calls': lead_web_tool_calls(s['tools']), 'engine': s.get('engine'), **facts})
    if refused_stream and not rec['answered']:
        rec['harness_error'] = 'stream refused: ' + '; '.join(s['errors'])[:160]
    rec['forced'] = (rec['model_used'] == spec) if rec['model_used'] else None
    rec['attribution'] = attribute(rec)
    return rec


# ── summary ──────────────────────────────────────────────────────────────────
def pct(xs, q):
    """Nearest-rank percentile (the suite's / the live-chat audit's rule). Pure."""
    xs = sorted(x for x in xs if isinstance(x, (int, float)) and not isinstance(x, bool))
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))] if xs else None


def _ttft_s(r):
    return r['ttft_ms'] / 1000 if r.get('ttft_ms') is not None else r.get('first_chunk_s')


def _done_s(r):
    return r['completion_ms'] / 1000 if r.get('completion_ms') is not None else r.get('complete_s')


def _stats(rs):
    sent = [r for r in rs if r.get('attribution') not in NOT_SENT]
    measured = [r for r in sent if r['attribution'] == 'measured']
    counted = [r for r in sent if r['attribution'] in ('measured', 'failed', 'failover')]
    rnd = lambda v, k=1: None if v is None else round(v, k)
    return {
        'n': len(sent),
        'forced': sum(1 for r in sent if r.get('forced') is True),
        'diverted': sum(1 for r in sent if r['attribution'] == 'diverted'),
        'failover': sum(1 for r in sent if r['attribution'] == 'failover'),
        'refused': sum(1 for r in rs if r.get('attribution') == 'refused'),
        'ttft_p50_s': rnd(pct([_ttft_s(r) for r in measured], 0.5)),
        'ttft_p90_s': rnd(pct([_ttft_s(r) for r in measured], 0.9)),
        'done_p50_s': rnd(pct([_done_s(r) for r in measured], 0.5)),
        'fail_rate': rnd(sum(1 for r in counted if r['attribution'] != 'measured') / len(counted), 3) if counted else None,
        'tools_p50': pct([r.get('tool_calls', 0) for r in measured], 0.5),
        'web_tools_p50': pct([r.get('web_tool_calls', 0) for r in measured], 0.5),
    }


def record_kind(r):
    """The kind a record files under in the LOCAL summary — the question's kind, else the answer's classified kind (on
    a kind run the question's kind is the title kind, the ingest's rule; a plain-title run's rows file under the
    classified kind in the ingest). Pure."""
    k = r.get('kind') if r.get('kind') in KINDS else r.get('plan_kind')
    return k if k in KINDS else None


def summarize_models(records, models):
    """Per model (in --models order): n sent, forced share, TTFT p50/p90 + done p50 over MEASURED rows (server
    metadata.ux, else the stream's own clock), fail rate over attributable rows, tool calls p50; per lane; and per
    task kind (record_kind — empty when no record has one). Pure."""
    out = []
    for spec in models:
        rs = [r for r in records if r.get('spec') == spec]
        lanes, kinds = {}, {}
        for r in rs:
            if r.get('attribution') in NOT_SENT or r.get('attribution') == 'diverted':
                continue
            lanes.setdefault(r.get('lane') or 'none', []).append(r)
            if record_kind(r):
                kinds.setdefault(record_kind(r), []).append(r)
        out.append({'spec': spec, **_stats(rs), 'lanes': {k: _stats(v) for k, v in sorted(lanes.items())},
                    'kinds': {k: _stats(kinds[k]) for k in KINDS if k in kinds}})
    return out


def kind_agreement(records):
    """The question's kind (the title kind on a kind run) vs the answer's classified kind over SENT records that carry
    one: {agree, differ, unstamped} counts (a calibration readout for the task_kind classifier — counts only). Pure."""
    out = {'agree': 0, 'differ': 0, 'unstamped': 0}
    for r in records:
        if r.get('attribution') in NOT_SENT or r.get('kind') not in KINDS:
            continue
        pk = r.get('plan_kind')
        out['unstamped' if pk not in KINDS else ('agree' if pk == r['kind'] else 'differ')] += 1
    return out


def _cell(v):
    return '-' if v is None else str(v)


def markdown_summary(summary, meta, agreement=None):
    qs_note = f" ({meta['question_set']} set)" if meta.get('question_set') not in (None, 'corpus') else ''
    lines = [f"# Model bench {meta['run_id']} — seed {meta['seed']} · {meta['questions']} questions{qs_note} × {len(summary)} models · "
             f"{time.strftime('%Y-%m-%d %H:%MZ', time.gmtime())}", '',
             'Forced = the spec actually led (metadata.models.digby.modelUsed); a Quick-lane diversion is excluded from the '
             'latency / fail columns; a failover (another model finished) counts as a failure. Latency = server '
             'metadata.ux over measured rows. Quality comes from the ingest (model-bench-ingest.js).', '',
             '| model | n | forced | diverted | TTFT p50 s | TTFT p90 s | done p50 s | fail rate | tools p50 | web tools p50 |',
             '|---|---|---|---|---|---|---|---|---|---|']
    for s in summary:
        forced = f"{s['forced']}/{s['n']}" if s['n'] else '-'
        lines.append(f"| {s['spec']} | {s['n']} | {forced} | {s['diverted']} | {_cell(s['ttft_p50_s'])} | {_cell(s['ttft_p90_s'])} | "
                     f"{_cell(s['done_p50_s'])} | {_cell(s['fail_rate'])} | {_cell(s['tools_p50'])} | {_cell(s['web_tools_p50'])} |" + (f" ⚠ {s['refused']} refused" if s['refused'] else ''))
    lines += ['', '## By lane (the answer\'s turn-plan lane)', '', '| model | lane | n | TTFT p50 s | done p50 s | fail rate | web tools p50 |', '|---|---|---|---|---|---|---|']
    for s in summary:
        for lane, st in s['lanes'].items():
            lines.append(f"| {s['spec']} | {lane} | {st['n']} | {_cell(st['ttft_p50_s'])} | {_cell(st['done_p50_s'])} | {_cell(st['fail_rate'])} | {_cell(st['web_tools_p50'])} |")
    if any(s.get('kinds') for s in summary):
        lines += ['', "## By task kind (the question's kind, else the answer's classified kind)", '',
                  '| model | kind | n | TTFT p50 s | done p50 s | fail rate | web tools p50 |', '|---|---|---|---|---|---|---|']
        for s in summary:
            for kind, st in (s.get('kinds') or {}).items():
                lines.append(f"| {s['spec']} | {kind} | {st['n']} | {_cell(st['ttft_p50_s'])} | {_cell(st['done_p50_s'])} | {_cell(st['fail_rate'])} | {_cell(st['web_tools_p50'])} |")
    if agreement and sum(agreement.values()):
        lines += ['', f"Kind agreement (the question's kind vs the answer's classified task kind): {agreement['agree']} agree · "
                  f"{agreement['differ']} differ · {agreement['unstamped']} unstamped."]
    return '\n'.join(lines) + '\n'


def print_summary(summary):
    print(f"{'model':52} {'n':>3} {'forced':>7} {'div':>4} {'ttft50':>7} {'ttft90':>7} {'done50':>7} {'fail':>6} {'tools':>5} {'web':>4}")
    for s in summary:
        print(f"{s['spec'][:52]:52} {s['n']:>3} {s['forced']:>3}/{s['n']:<3} {s['diverted']:>4} {_cell(s['ttft_p50_s']):>7} "
              f"{_cell(s['ttft_p90_s']):>7} {_cell(s['done_p50_s']):>7} {_cell(s['fail_rate']):>6} {_cell(s['tools_p50']):>5} {_cell(s['web_tools_p50']):>4}")


# ── cleanup ──────────────────────────────────────────────────────────────────
def run_chats(api, run_id, max_pages=200):
    """Every chat of the account whose title is this run's (`model-bench <runId> …`, the preflight chats included)."""
    prefix = f'{TITLE_PREFIX} {run_id} '
    hits, page = [], 1
    while page <= max_pages:
        chats, pagination = api.list_chats_page(page)
        hits += [c for c in chats if isinstance(c, dict) and str(c.get('title') or '').startswith(prefix)]
        total_pages = pagination.get('totalPages') or pagination.get('pages')
        if len(chats) < 50 or (total_pages and page >= int(total_pages)):
            break
        page += 1
    return hits


def account_refusal(email, base):
    """The bench never runs on an account other than the canonical test account against prod. Pure."""
    if 'digby.ai' in str(base) and str(email or '').strip().lower() != BENCH_ACCOUNT:
        return f'model-bench runs ONLY as {BENCH_ACCOUNT} against {base} (owner rule: no exploration on real users)'
    return ''


# ── self-test (no network) ───────────────────────────────────────────────────
TASK_KIND_TS = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'backend', 'src', 'modules', 'crossmodel', 'platform', 'task-kind.ts')


def ts_task_kind_twins(path=TASK_KIND_TS):
    """(TASK_KINDS tuple, BENCH_GROUP_KIND dict) parsed from the TS leaf's text — the twins KINDS / GROUP_KIND must
    equal; (None, None) when the file or a literal is missing. Pure over the file."""
    try:
        with open(path) as fh:
            src = fh.read()
    except OSError:
        return None, None
    m = re.search(r'TASK_KINDS\s*:\s*readonly\s+TaskKind\[\]\s*=\s*\[([^\]]*)\]', src)
    kinds = tuple(re.findall(r"'([a-z]+)'", m.group(1))) if m else None
    m = re.search(r'BENCH_GROUP_KIND\b[^=]*=\s*\{([^}]*)\}', src)
    group_kind = dict(re.findall(r"([A-Za-z_]+)\s*:\s*'([a-z]+)'", m.group(1))) if m else None
    return kinds, group_kind


def self_test():
    ok = True

    def check(cond, label):
        nonlocal ok
        print(('  ok: ' if cond else '  FAIL: ') + label)
        ok = ok and bool(cond)

    # titles — the SAME literal the backend jest test pins (model-bench-scorecard.test.ts)
    t = bench_title('mb20261004a', 3, 'cql-litellm:api-optimize-alibaba-qwen3.8-flash')
    check(t == 'model-bench mb20261004a q3 cql-litellm:api-optimize-alibaba-qwen3.8-flash', 'the title is `model-bench <runId> q<idx> <spec>`')
    check(parse_bench_title(t) == {'run_id': 'mb20261004a', 'idx': 3, 'spec': 'cql-litellm:api-optimize-alibaba-qwen3.8-flash'}, 'a title round-trips')
    check(all(parse_bench_title(x) is None for x in ['e2e suite 01 10:00', 'model-bench r1 q0 glm-5.3', 'model-bench r/1 q1 glm-5.3', 'model-bench r1 q1 glm 5.3', 'model-bench mb1 preflight']),
          'other titles (incl. the preflight chat) never parse as a bench row')
    check(valid_run_id(default_run_id(0)) and default_run_id(0) == 'mb19700101T000000', 'the default run id is a valid timestamp tag')
    check(not valid_run_id('a b') and not valid_run_id('') and not valid_run_id('x' * 65), 'run ids are one short token')
    check(parse_models(' glm-5.3, deepseek-flash,glm-5.3 ,, cql-litellm:x ') == ['glm-5.3', 'deepseek-flash', 'cql-litellm:x'], 'models: order kept, duplicates dropped')
    try:
        parse_models('glm 5.3')
        check(False, 'a spec with a space is refused')
    except ValueError:
        check(True, 'a spec with a space is refused')
    # stratification + no noise
    groups = {g for g, _, f in hc.CORPUS if not (set(f) & SKIP_FLAGS)}
    a = sample_questions(12, 7)
    check(len(a) == 12 and [q['idx'] for q in a] == list(range(1, 13)), 'n questions, numbered 1..n')
    check(a == sample_questions(12, 7) and [q['text'] for q in a] != [q['text'] for q in sample_questions(12, 8)], 'deterministic for a seed, different across seeds')
    check(len({q['group'] for q in a}) == min(12, len(groups)), 'stratified: one question per group before any group repeats')
    big = sample_questions(len(groups) * 2, 3)
    counts = {}
    for q in big:
        counts[q['group']] = counts.get(q['group'], 0) + 1
    avail = {}
    for g, _, f in eligible_corpus():
        avail[g] = avail.get(g, 0) + 1
    top = max(counts.values())
    check(all(counts.get(g, 0) >= min(avail[g], top - 1) for g in avail), 'balanced: a group falls behind only once its entries run out')
    check(not any(set(q['flags']) & SKIP_FLAGS for q in big), "no 'code' / 'vague' entry is ever asked")
    check(not any('{' + k + '}' in q['text'] for q in big for k in hc.SLOTS), 'every slot is filled')
    real_noise = hc.noise
    hc.noise = lambda *x, **k: (_ for _ in ()).throw(AssertionError('noise() called'))
    try:
        sample_questions(30, 11)
        check(True, 'sampling never calls noise() — identical text for every model')
    except AssertionError:
        check(False, 'sampling never calls noise() — identical text for every model')
    finally:
        hc.noise = real_noise
    pref = [(q['template'].split('{')[0], q['template'].split('}')[-1] if '}' in q['template'] else '', q['text']) for q in big]
    check(all(text.startswith(head) and text.endswith(tail) for head, tail, text in pref), 'each question is its template, filled — no prefix / suffix / case / typo noise')
    only = sample_questions(5, 1, groups={'health', 'money'})
    check(only and all(q['group'] in ('health', 'money') for q in only), '--groups restricts the corpus')
    # the plan: interleaved, rotated, identical text
    models = ['glm-5.3', 'deepseek-flash', 'cql-litellm:x']
    tasks = plan_tasks(a[:4], models)
    check(len(tasks) == 12 and [t['question']['idx'] for t in tasks] == [1, 1, 1, 2, 2, 2, 3, 3, 3, 4, 4, 4], 'interleaved: every model on q1, then q2, …')
    check([t['spec'] for t in tasks[:3]] == models and [t['spec'] for t in tasks[3:6]] == models[1:] + models[:1], 'the model order rotates one step per question')
    check(all(sorted(t['spec'] for t in tasks[i:i + 3]) == sorted(models) for i in range(0, 12, 3)), 'each question runs every model exactly once')
    check(pacing_floor_minutes(20) == 0 and pacing_floor_minutes(80) == 30, 'the pacing floor estimate follows ≤ 20 starts / 10 min')
    # forced detection + attribution
    base = {'spec': 'glm-5.3', 'answered': True, 'answer_chars': 120, 'model_used': 'glm-5.3', 'plan_lane': None, 'lead_error': None}
    check(attribute(base) == 'measured', 'the spec led → measured')
    check(attribute({**base, 'model_used': 'cql-litellm:qwen3.8-flash', 'plan_lane': 'quick'}) == 'diverted', 'the Quick lane ran another model → diverted (excluded)')
    check(attribute({**base, 'model_used': 'kimi-k3'}) == 'failover', 'another model finished the turn → failover (a failure)')
    check(attribute({**base, 'answered': False, 'answer_chars': 0, 'model_used': None}) == 'failed', 'no answer → failed')
    check(attribute({**base, 'lead_error': 'returned no output'}) == 'failed', 'a lead error → failed')
    check(attribute({**base, 'model_used': None}) == 'unverified', 'an answer with no recorded leader → unverified')
    check(attribute({**base, 'lead_model_error': 'HTTP 400: not offered'}) == 'refused', 'a refused lead pick → refused (never sent)')
    msg = {'id': 'a1', 'role': 'assistant', 'content': 'It is 9 °C.', 'metadata': {
        'models': {'digby': {'modelUsed': 'cql-litellm:qwen3.8-flash'}}, 'depth': {'turnPlan': {'lane': 'quick', 'act': True}, 'plan': {'lane': 'quick', 'preset': 'single_thinking'}},
        'ux': {'ttftMs': 6100, 'completionMs': 9400}}}
    f = bench_facts(msg)
    check(f['model_used'] == 'cql-litellm:qwen3.8-flash' and f['lane'] == 'quick' and f['plan_lane'] == 'quick' and f['ttft_ms'] == 6100 and f['completion_ms'] == 9400 and f['answer_chars'] == 11,
          'bench_facts reads modelUsed, the turn-plan lane, the plan lane and metadata.ux')
    check(attribute({**f, 'spec': 'glm-5.3'}) == 'diverted' and bench_facts(None)['answered'] is False, 'a Quick answer on a glm-5.3 chat is a diversion; no row = not answered')
    # summary + report
    recs = [
        {**base, 'attribution': 'measured', 'forced': True, 'lane': 'standard', 'ttft_ms': 4000, 'completion_ms': 12000, 'tool_calls': 2},
        {**base, 'attribution': 'measured', 'forced': True, 'lane': 'standard', 'ttft_ms': 8000, 'completion_ms': 20000, 'tool_calls': 0},
        {**base, 'attribution': 'failover', 'forced': False, 'lane': 'checked', 'model_used': 'kimi-k3'},
        {**base, 'attribution': 'diverted', 'forced': False, 'lane': 'quick'},
        {**base, 'attribution': 'refused', 'lead_model_error': 'x'},
        {**base, 'spec': 'deepseek-flash', 'attribution': 'failed', 'forced': None, 'answered': False, 'lane': None},
    ]
    summ = summarize_models(recs, ['glm-5.3', 'deepseek-flash'])
    g = summ[0]
    check(g['n'] == 4 and g['forced'] == 2 and g['diverted'] == 1 and g['refused'] == 1 and g['ttft_p50_s'] == 8.0 and g['done_p50_s'] == 20.0 and g['fail_rate'] == 0.333 and g['tools_p50'] == 2,
          'per-model stats: n sent, forced, diverted, latency over measured rows, failover counted as a failure')
    check(set(g['lanes']) == {'standard', 'checked'} and summ[1]['fail_rate'] == 1.0 and summ[1]['lanes'].get('none', {}).get('n') == 1, 'per-lane stats; a missing answer counts against its model')
    md = markdown_summary(summ, {'run_id': 'mb1', 'seed': 7, 'questions': 3})
    check('| glm-5.3 | 4 | 2/4 | 1 | 8.0 |' in md and '⚠ 1 refused' in md and '| deepseek-flash | none | 1 |' in md, 'the markdown table renders a row per model and per lane')
    # run_task end to end on a fake transport (no network, no sleeps)
    class FakeApi:
        def __init__(self, refusal=None, errors=None, msgs=None):
            self.refusal, self.errors, self.msgs, self.streams, self.titles = refusal, errors or [], msgs or [], 0, []

        def new_chat(self, title):
            self.titles.append(title)
            return 'c1'

        def set_lead_model(self, chat_id, spec):
            return (None, self.refusal) if self.refusal else (spec, None)

        def stream(self, message, chat_id, escalation_of=None, timeout=900):
            self.streams += 1
            return {'errors': self.errors, 'timed_out': False, 'first_chunk_s': None if self.errors else 5.2, 'complete_s': None if self.errors else 11.0,
                    'tools': [] if self.errors else [['Digby', 'search_engine'], ['Digby', 'search_engine']], 'engine': 'chat'}

        def messages(self, chat_id):
            return self.msgs

    class NoPacer:
        def wait(self):
            pass

    q1 = {'idx': 4, 'group': 'trivia', 'flags': [], 'text': 'why is the ocean salty'}
    answered = [{'id': 'u', 'role': 'user', 'content': 'why is the ocean salty'},
                {'id': 'a', 'role': 'assistant', 'content': 'Rivers carry dissolved minerals…', 'metadata': {
                    'models': {'digby': {'modelUsed': 'glm-5.3'}}, 'depth': {'turnPlan': {'lane': 'standard'}, 'plan': {}}, 'ux': {'ttftMs': 5000, 'completionMs': 10800}}}]
    real_time = qs.time
    qs.time = type('T', (), {'time': staticmethod(time.time), 'sleep': staticmethod(lambda s: None), 'strftime': staticmethod(time.strftime), 'gmtime': staticmethod(time.gmtime)})
    try:
        fa = FakeApi(msgs=answered)
        r = run_task(fa, NoPacer(), {'question': q1, 'spec': 'glm-5.3'}, 'mb1', 900, 300)
        check(fa.titles == ['model-bench mb1 q4 glm-5.3'] and r['attribution'] == 'measured' and r['forced'] is True and r['tool_calls'] == 2
              and r['tools'] == ['search_engine'] and r['ttft_ms'] == 5000 and r['lane'] == 'standard', 'run_task: titled chat, pinned lead, streamed, answer read → measured')
        check(r['web_tool_calls'] == 2, "run_task records the lead's web tool calls from the stream (roster 2026-10-06 C-2)")
        fa = FakeApi(refusal='HTTP 400: "x" is not a lead model this instance offers')
        r = run_task(fa, NoPacer(), {'question': q1, 'spec': 'x'}, 'mb1', 900, 300)
        check(r['attribution'] == 'refused' and fa.streams == 0 and 'not a lead model' in r['lead_model_error'], 'a refused lead pick is recorded and never streamed')
        fa = FakeApi(errors=['HTTP 429'])
        r = run_task(fa, NoPacer(), {'question': q1, 'spec': 'glm-5.3'}, 'mb1', 900, 300)
        check(r['attribution'] == 'harness' and 'stream refused' in r['harness_error'], "a 429 on the stream is the harness's problem, never the model's")
    finally:
        qs.time = real_time
    # account guard + the suite's transport
    check(account_refusal('someone@else.com', 'https://digby.ai/api') and not account_refusal('ClaudeBot@digby.ai ', 'https://digby.ai/api'), 'prod runs only as the canonical test account')
    check(not account_refusal('dev@local', 'http://localhost:4000/api'), 'a local backend may use a local account')
    check(issubclass(BenchApi, qs.Api) and qs.Pacer and qs.find_answer and qs.open_with_retry, "the bench reuses the suite's Api / Pacer / find_answer / open_with_retry")
    # roster 2026-10-06 C-2: the TOOL-USING question set, --question-set, --lanes, web tool counts
    check(len(TOOL_CORPUS) >= 12 and all(g == TOOLS_GROUP and 'web' in f and not (set(f) & SKIP_FLAGS) for g, _, f in TOOL_CORPUS),
          'the tool set has ≥ 12 entries, all in group tools, all flagged web, none code / vague')
    fill_rng = random.Random(5)
    check(not any('{' + k + '}' in hc.fill(t, fill_rng) for _, t, _ in TOOL_CORPUS for k in hc.SLOTS) and not any('{' in hc.fill(t, fill_rng) for _, t, _ in TOOL_CORPUS),
          'every tool-set template fills completely from human_corpus.SLOTS')
    check(len({t for _, t, _ in TOOL_CORPUS}) == len(TOOL_CORPUS) and not ({t for _, t, _ in TOOL_CORPUS} & {t for _, t, _ in hc.CORPUS}), 'tool-set templates are unique and not copies of the corpus')
    tq = sample_questions(10, 7, None, 'tools')
    check(len(tq) == 10 and all(q['group'] == TOOLS_GROUP for q in tq), '--question-set tools draws only the tool set')
    mq = sample_questions(len({g for g, _, f in hc.CORPUS if not (set(f) & SKIP_FLAGS)}) + 2, 7, None, 'mixed')
    check(any(q['group'] == TOOLS_GROUP for q in mq) and any(q['group'] != TOOLS_GROUP for q in mq), '--question-set mixed stratifies the corpus and the tool set together')
    check(sample_questions(12, 7) == sample_questions(12, 7, None, 'corpus') and not any(q['group'] == TOOLS_GROUP for q in sample_questions(40, 7)),
          'the default corpus set is unchanged (same seed → same questions, no tool entries)')
    corpus_groups = {g for g, _, _ in hc.CORPUS}
    check(all(g in corpus_groups or g == TOOLS_GROUP for gs in LANE_GROUPS.values() for g in gs), 'every --lanes family names a real human_corpus group (or the tool set)')
    check(set(LANE_GROUPS) == {'quick', 'standard', 'checked', 'tools'} and lane_groups(['quick', 'tools']) == set(LANE_GROUPS['quick']) | {TOOLS_GROUP}, '--lanes resolves to the union of its families')
    try:
        lane_groups(['research'])
        check(False, 'an unknown lane is refused')
    except ValueError:
        check(True, 'an unknown lane is refused')
    check(resolve_selection('corpus', ['tools'], None) == ('mixed', {TOOLS_GROUP}), 'a tools lane pulls the tool set in under --question-set corpus')
    check(resolve_selection('corpus', [], {'health'}) == ('corpus', {'health'}) and resolve_selection('corpus', [], None) == ('corpus', None), '--groups alone keeps today\'s selection')
    check(resolve_selection('mixed', ['checked'], {'lookup'})[1] == set(LANE_GROUPS['checked']) | {'lookup'}, '--lanes and --groups combine as a union')
    lq = sample_questions(6, 3, resolve_selection('corpus', ['checked'], None)[1])
    check(lq and all(q['group'] in LANE_GROUPS['checked'] for q in lq), 'a lane-restricted sample only draws that family')
    check(lead_web_tool_calls([['Digby', 'search_engine'], ['Double Checker', 'search_engine'], ['Digby', 'search_memory'], ['Digby', 'scrape_as_markdown'], ['coding', 'web_pipe'], 'bad'])
          == 3, "web_tool_calls counts the lead's web tools only (a checker's searches and non-web tools excluded)")
    wsum = summarize_models([{**base, 'attribution': 'measured', 'lane': 'standard', 'web_tool_calls': 2}, {**base, 'attribution': 'measured', 'lane': 'standard', 'web_tool_calls': 0},
                             {**base, 'attribution': 'measured', 'lane': 'standard', 'web_tool_calls': 3}], ['glm-5.3'])
    check(wsum[0]['web_tools_p50'] == 2 and '| web tools p50 |' in markdown_summary(wsum, {'run_id': 'mb1', 'seed': 7, 'questions': 3, 'question_set': 'tools'}),
          'the summary carries web tools p50 and the report names the question set')
    # 2026-10-20 TASK KINDS: the twins, the title token, the kind question set, --kinds / --per-kind, plan_kind
    ts_kinds, ts_group_kind = ts_task_kind_twins()
    check(ts_kinds is not None and KINDS == ts_kinds, f'KINDS equals the TS leaf TASK_KINDS, in order ({ts_kinds})')
    check(ts_group_kind is not None and GROUP_KIND == ts_group_kind, 'GROUP_KIND equals the TS leaf BENCH_GROUP_KIND')
    every = eligible_corpus(None, 'kinds', allow_code=True)
    all_groups = {g for g, _, _ in every}
    check(all(g in GROUP_KIND for g in all_groups) and set(GROUP_KIND.values()) <= set(KINDS), 'every eligible group maps to exactly one known kind')
    check(set(GROUP_KIND) <= {g for g, _, _ in question_pool('kinds')} and sum(len(v) for v in KIND_GROUPS.values()) == len(GROUP_KIND),
          'GROUP_KIND names only real groups and KIND_GROUPS partitions them')
    per = {k: sum(1 for g, _, f in every if question_kind(g, f) == k) for k in KINDS}
    check(all(n >= 10 for n in per.values()), f'every kind has ≥ 10 templates in the kind question set ({per})')
    kc = {}
    for g, _, f in KIND_CORPUS:
        kc[question_kind(g, f)] = kc.get(question_kind(g, f), 0) + 1
    check(kc.get('code', 0) >= 8 and kc.get('planning', 0) >= 6 and kc.get('analysis', 0) >= 6 and kc.get('writing', 0) >= 4,
          f'KIND_CORPUS adds ≥ 8 code, ≥ 6 planning, ≥ 6 analysis, ≥ 4 writing ({kc})')
    kt = [t for g, t, _ in KIND_CORPUS if g == 'writing']
    check(any('name ideas' in t for t in kt) and any('logo' in t for t in kt), 'the writing kind questions include a naming ask and a logo brief')
    check(len({t for _, t, _ in KIND_CORPUS}) == len(KIND_CORPUS) and not ({t for _, t, _ in KIND_CORPUS} & ({t for _, t, _ in hc.CORPUS} | {t for _, t, _ in TOOL_CORPUS})),
          'kind-set templates are unique and not copies of the corpus or the tool set')
    check(all(g in GROUP_KIND and not (set(f) & {'vague'}) for g, _, f in KIND_CORPUS) and all(('code' in f) == (g == 'code') for g, _, f in KIND_CORPUS),
          'kind-set entries are in mapped groups, never vague; exactly the code entries carry the code flag')
    kfill = random.Random(9)
    check(not any('{' + k + '}' in hc.fill(t, kfill) for _, t, _ in KIND_CORPUS for k in hc.SLOTS), 'every kind-set template fills from human_corpus.SLOTS')
    kt_title = bench_title('mb20261020a', 7, 'glm-5.3', 'code')
    check(kt_title == 'model-bench mb20261020a q7 glm-5.3 k:code' and parse_bench_title(kt_title) == {'run_id': 'mb20261020a', 'idx': 7, 'spec': 'glm-5.3', 'kind': 'code'},
          'a kind title carries `k:<kind>` and round-trips (the TS twin pins the same literal)')
    check(bench_title('r1', 1, 'glm-5.3', 'research') == 'model-bench r1 q1 glm-5.3' and bench_title('r1', 1, 'glm-5.3', None) == 'model-bench r1 q1 glm-5.3'
          and 'kind' not in parse_bench_title('model-bench r1 q1 glm-5.3'), 'no / an unknown kind writes no token; a kind-less title parses with no kind key')
    check(parse_bench_title('model-bench r1 q1 glm-5.3 k:research') == {'run_id': 'r1', 'idx': 1, 'spec': 'glm-5.3'}
          and all(parse_bench_title(x) is None for x in ['model-bench r1 q1 glm-5.3 k:Code', 'model-bench r1 q1 glm-5.3 k:', 'model-bench r1 q1 glm-5.3 k:code x', 'model-bench r1 q1 glm-5.3  k:code']),
          'an unknown kind token still parses (no kind); a malformed token is extra words → None')
    check(all(q['kind'] == question_kind(q['group'], q['flags']) for q in sample_questions(30, 7, None, 'mixed')), 'every sampled question carries its kind (a kind= flag, else its group\'s)')
    check(question_kind('lang', {'lang=es', 'kind=lookup'}) == 'lookup' and question_kind('lang', {'lang=fr'}) == 'writing'
          and question_kind('lang', {'kind=research'}) == 'writing', 'a kind= flag overrides the group kind; an unknown kind= is ignored')
    lang_kinds = {t: question_kind(g, f) for g, t, f in hc.CORPUS if g == 'lang'}
    check(any(k == 'lookup' for k in lang_kinds.values()) and any(k == 'explain' for k in lang_kinds.values()),
          f'the mixed lang group files its lookup and grammar questions under their own kinds ({lang_kinds})')
    check(resolve_selection('corpus', [], None, ['planning']) == ('kinds', {'plan'}) and resolve_selection('mixed', [], None, ['lookup'])[0] == 'kinds'
          and resolve_selection('tools', [], None, ['lookup'])[0] == 'tools', '--kinds pulls the kind question set in (an explicit tools set stays tools)')
    check(resolve_selection('corpus', ['quick'], {'health'}, ['code'])[1] == set(LANE_GROUPS['quick']) | {'health', 'code'}, '--kinds, --lanes and --groups combine as a union')
    try:
        kind_groups(['research'])
        check(False, 'an unknown kind is refused')
    except ValueError:
        check(True, 'an unknown kind is refused')
    cq = sample_questions(12, 7, kind_groups(['code']), 'kinds', allow_code=True)
    check(len(cq) >= 10 and all(q['kind'] == 'code' for q in cq) and any('code' in q['flags'] for q in cq), '--kinds code asks code questions (the code skip lifted only for it)')
    check(not any('code' in q['flags'] for q in sample_questions(40, 7, kind_groups(['writing', 'planning']), 'kinds')), 'without the code kind no code question is ever asked')
    pk = sample_per_kind(4, 11)
    pk_counts = {k: sum(1 for q in pk if q['kind'] == k) for k in KINDS}
    check(all(v == 4 for v in pk_counts.values()) and [q['idx'] for q in pk] == list(range(1, len(pk) + 1)), f'--per-kind 4 → 4 questions of every kind, numbered 1..n ({pk_counts})')
    check(pk == sample_per_kind(4, 11) and [q['text'] for q in pk] != [q['text'] for q in sample_per_kind(4, 12)], 'per-kind sampling is deterministic for a seed, different across seeds')
    check(len({q['kind'] for q in pk[:len(KINDS)]}) == len(KINDS), 'per-kind questions interleave across kinds (one of each kind per round)')
    # --continue-from (2026-10-20): a second wave of the SAME run id continues the idx and never repeats a template.
    rx = template_regex('plan a one week road trip starting from {city} with about 4 stops')
    check(bool(rx.match('plan a one week road trip starting from Halifax with about 4 stops')) and not rx.match('plan a one week road trip starting from Halifax with about 4 stops, thanks')
          and bool(template_regex('what is 2+2? (x)').match('what is 2+2? (x)')), 'a template matches its own fills (any slot value, regex metacharacters literal), nothing longer')
    wave_a = sample_per_kind(4, 11)
    asked_a = {q['text'] for q in wave_a}
    wave_b = renumber(sample_per_kind(4, 11, asked=asked_a), max(q['idx'] for q in wave_a))
    check(not ({q['template'] for q in wave_a} & {q['template'] for q in wave_b}) and len(wave_b) == len(wave_a)
          and [q['idx'] for q in wave_b] == list(range(len(wave_a) + 1, 2 * len(wave_a) + 1)),
          'a continued wave skips every template the first asked and numbers its questions after the first wave')
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        fp = os.path.join(td, 'a.jsonl')
        with open(fp, 'w') as fh:
            for q in wave_a:
                for sp in ('m1', 'm2'):
                    fh.write(json.dumps({'run_id': 'rA', 'q': q['idx'], 'question': q['text'], 'spec': sp, 'title': bench_title('rA', q['idx'], sp, q['kind'])}) + '\n')
        top, asked = load_prior_wave(fp, 'rA')
        check(top == len(wave_a) and asked == asked_a, 'load_prior_wave reads the last idx and the asked texts')
        try:
            load_prior_wave(fp, 'rB')
            check(False, 'a prior wave of another run id is refused')
        except ValueError:
            check(True, 'a prior wave of another run id is refused')
        pw = load_prior_waves([fp], 'rA')
        check(pw['complete'] and pw['specs'] == {'m1', 'm2'} and pw['tagged'] == {True}, 'a finished wave is complete, with its field and title mode')
        fp2 = os.path.join(td, 'cut.jsonl')
        with open(fp2, 'w') as fh:
            for q in wave_a[:-1]:
                for sp in ('m1', 'm2'):
                    fh.write(json.dumps({'run_id': 'rA', 'q': q['idx'], 'question': q['text'], 'spec': sp}) + '\n')
            fh.write(json.dumps({'run_id': 'rA', 'q': wave_a[-1]['idx'], 'question': wave_a[-1]['text'], 'spec': 'm1'}) + '\n')
        cut = load_prior_waves([fp2], 'rA')
        check(not cut['complete'] and cut['missing'] == [wave_a[-1]['idx']], 'a wave cut mid-question is NOT complete (its missing q listed)')
        av = os.path.join(td, 'avoid.json')
        with open(av, 'w') as fh:
            json.dump(['x one', 'x two'], fh)
        check(load_avoid([av, fp]) == {'x one', 'x two'} | asked_a, '--avoid reads a JSON list and a JSONL')
    ex = existing_run_facts(['model-bench rA q1 m1 k:code', 'model-bench rA q70 m2 k:code', 'model-bench rA preflight', 'other'])
    check(ex == {'n': 2, 'top': 70, 'specs': {'m1', 'm2'}, 'tagged': {True}}, 'the server facts read only bench titles')
    check(continuation_refusal(None, 1, ['m1'], True, False) is None and continuation_refusal({'n': 0}, 1, ['m1'], True, False) is None, 'a fresh run id goes')
    check('already has' in (continuation_refusal(ex, 1, ['m1', 'm2'], True, False) or ''), 'a fresh run onto an existing run id is refused')
    check('collides' in (continuation_refusal(ex, 70, ['m1', 'm2'], True, True) or '') and continuation_refusal(ex, 101, ['m1', 'm2'], True, True) is None,
          'a first idx at or below the server\'s highest is refused; past it goes')
    check('field' in (continuation_refusal(ex, 101, ['m1', 'm3'], True, True) or '') and 'title mode' in (continuation_refusal(ex, 101, ['m1', 'm2'], False, True) or ''),
          'a different model field or title mode is refused')
    rl = relabel_plan([{'q': 19, 'group': 'trivia', 'kind': 'lookup', 'question': 'why is the ocean salty'},
                       {'q': 1, 'group': 'trivia', 'kind': 'lookup', 'question': 'how many bones are in the human body'}])
    check([(r['q'], k) for r, k in rl] == [(19, 'explain')], 'relabel re-files only a record the corpus now files under another kind')
    tq = renumber(sample_per_kind(2, 3, ['code', 'writing']), 70)
    check([t['spec'] for t in plan_tasks(tq, ['a', 'b', 'c'])[:3]] == ['a', 'b', 'c'], 'a continued wave rotates by list position (plan_tasks) — the dry run prints the same order')
    lk = [q for q in sample_per_kind(12, 3, ['lookup', 'advice'])]
    adv_strata = {kind_stratum(g, 'advice') for g, _, f in eligible_corpus(None, 'kinds') if question_kind(g, f) == 'advice'}
    check({q['kind'] for q in lk} == {'lookup', 'advice'} and len({q['group'] for q in lk if q['kind'] == 'lookup'}) >= 5
          and {kind_stratum(q['group'], 'advice') for q in lk if q['kind'] == 'advice'} == adv_strata == set(KIND_GROUPS['advice']),
          'per-kind sampling stratifies across each kind\'s groups (a re-filed entry samples in its kind\'s home group)')
    check(all(GROUP_KIND.get(h) == k for k, h in KIND_HOME_GROUP.items()) and set(KIND_HOME_GROUP) == set(KINDS), 'every kind\'s home group is a group of that kind')
    # A re-filed entry is drawn no more often than its kind's most-drawn native entry (it was ~100% as a 1-entry stratum).
    draws, natives = {}, {}
    for sd in range(1, 61):
        for q in sample_per_kind(10, sd):
            draws[q['template']] = draws.get(q['template'], 0) + 1
    for g, t, f in eligible_corpus(None, 'kinds', allow_code=True):
        k = question_kind(g, f)
        if GROUP_KIND.get(g) == k:
            natives[k] = max(natives.get(k, 0), draws.get(t, 0))
    refiled = [(t, question_kind(g, f)) for g, t, f in eligible_corpus(None, 'kinds', allow_code=True) if GROUP_KIND.get(g) != question_kind(g, f)]
    check(refiled and all(draws.get(t, 0) <= natives[k] for t, k in refiled),
          f"re-filed entries are drawn no more than their kind's most-drawn native entry ({[(t[:24], draws.get(t, 0), natives[k]) for t, k in refiled]})")
    kq = sample_questions(40, 5, None, 'kinds', kinds=['lookup'])
    check(kq and all(q['kind'] == 'lookup' for q in kq) and any(q['group'] == 'lang' for q in sample_questions(80, 5, None, 'kinds', kinds=['lookup'])),
          'a --kinds run (no --per-kind) selects by the question\'s kind: no off-kind question, a re-filed on-kind one reachable')
    check(len(sample_per_kind(50, 3, ['planning'])) == per['planning'] and len({q['text'] for q in sample_per_kind(50, 3, ['planning'])}) == per['planning'],
          'a kind with fewer templates than --per-kind gives every one of them once')
    try:
        sample_per_kind(2, 1, ['research'])
        check(False, 'per-kind refuses an unknown kind')
    except ValueError:
        check(True, 'per-kind refuses an unknown kind')
    kmsg = {**msg, 'metadata': {**msg['metadata'], 'depth': {'turnPlan': {'lane': 'standard', 'taskKind': {'kind': 'code', 'top': 'code', 'p': 0.93, 'usable': True}}, 'plan': {}}}}
    check(bench_facts(kmsg)['plan_kind'] == 'code' and bench_facts(msg)['plan_kind'] is None and qs.answer_facts(kmsg)['plan_kind'] == 'code'
          and bench_facts({**kmsg, 'metadata': {**kmsg['metadata'], 'depth': {'turnPlan': {'taskKind': {'kind': 'research'}}}}})['plan_kind'] is None,
          "plan_kind = the answer's turnPlan.taskKind.kind (the suite's answer_facts), a known kind only")
    real_time = qs.time
    qs.time = type('T', (), {'time': staticmethod(time.time), 'sleep': staticmethod(lambda s: None), 'strftime': staticmethod(time.strftime), 'gmtime': staticmethod(time.gmtime)})
    try:
        stamped = [answered[0], {**answered[1], 'metadata': {**answered[1]['metadata'], 'depth': {'turnPlan': {'lane': 'standard', 'taskKind': {'kind': 'explain'}}, 'plan': {}}}}]
        fa = FakeApi(msgs=stamped)
        r = run_task(fa, NoPacer(), {'question': {**q1, 'kind': 'lookup'}, 'spec': 'glm-5.3'}, 'mb1', 900, 300, tag_kinds=True)
        check(fa.titles == ['model-bench mb1 q4 glm-5.3 k:lookup'] and r['title'] == fa.titles[0] and r['kind'] == 'lookup' and r['plan_kind'] == 'explain' and r['attribution'] == 'measured',
              'a KIND run: run_task writes the k:<kind> title token and records kind + plan_kind')
        # 2026-10-20 review: a default / --groups / --lanes run titles its chats PLAIN — the record keeps the kind
        fa = FakeApi(msgs=stamped)
        r = run_task(fa, NoPacer(), {'question': {**q1, 'kind': 'lookup'}, 'spec': 'glm-5.3'}, 'mb1', 900, 300)
        check(fa.titles == ['model-bench mb1 q4 glm-5.3'] and r['title'] == fa.titles[0] and r['kind'] == 'lookup' and r['plan_kind'] == 'explain',
              'a routine run: run_task writes a plain title (no k:<kind> token) yet the record carries kind + plan_kind')
    finally:
        qs.time = real_time
    check(not run_tags_kinds() and not run_tags_kinds([], None) and not run_tags_kinds(None, None)
          and run_tags_kinds(['code'], None) and run_tags_kinds([], 3) and run_tags_kinds(list(KINDS), 3),
          'only a kind run (--kinds or --per-kind) tags its titles with k:<kind>')
    check(title_kind({'kind': 'code'}, True) == 'code' and title_kind({'kind': 'code'}, False) is None and title_kind({}, True) is None and title_kind(None, True) is None,
          "the title carries the question's kind only when the run tags kinds")
    krecs = [
        {**base, 'attribution': 'measured', 'lane': 'standard', 'kind': 'code', 'plan_kind': 'code', 'ttft_ms': 4000},
        {**base, 'attribution': 'measured', 'lane': 'standard', 'kind': 'code', 'plan_kind': 'explain', 'ttft_ms': 6000},
        {**base, 'attribution': 'failed', 'lane': 'standard', 'kind': 'writing', 'plan_kind': None},
        {**base, 'attribution': 'measured', 'lane': 'standard', 'kind': None, 'plan_kind': 'planning', 'ttft_ms': 2000},
        {**base, 'attribution': 'diverted', 'lane': 'quick', 'kind': 'lookup'},
        {**base, 'attribution': 'refused', 'kind': 'lookup', 'lead_model_error': 'x'},
    ]
    ks = summarize_models(krecs, ['glm-5.3'])[0]
    check(list(ks['kinds']) == ['writing', 'code', 'planning'] and ks['kinds']['code']['n'] == 2 and ks['kinds']['code']['ttft_p50_s'] == 6.0 and ks['kinds']['writing']['fail_rate'] == 1.0,
          "per-kind stats: the question's kind, else plan_kind; diverted / never-sent rows left out; KINDS order")
    agree = kind_agreement(krecs)
    check(agree == {'agree': 1, 'differ': 1, 'unstamped': 2}, f'kind agreement counts the question\'s kind vs plan_kind over SENT records, a diverted answer included ({agree})')
    kmd = markdown_summary([ks], {'run_id': 'mb1', 'seed': 7, 'questions': 4, 'question_set': 'kinds'}, agree)
    check('## By task kind' in kmd and '| glm-5.3 | code | 2 |' in kmd and '1 agree · 1 differ · 2 unstamped' in kmd, 'the report carries a per-kind table and the agreement line')
    check('## By task kind' not in markdown_summary(summ, {'run_id': 'mb1', 'seed': 7, 'questions': 3}) and summ[0]['kinds'] == {},
          'a kind-less run renders no kind table')
    print('self-test', 'PASSED' if ok else 'FAILED')
    return ok


# ── main ─────────────────────────────────────────────────────────────────────
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--models', default='', help='comma list of lead specs (built-in ids or <label>:<modelId> registry specs)')
    ap.add_argument('--n', type=int, default=12, help='questions (each runs on every model)')
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--run-id', default='', help='tag in every chat title (default: mb<UTC timestamp>)')
    ap.add_argument('--groups', default='', help='comma list of human_corpus groups to draw from (default: all but code / vague entries; `tools` = the tool set)')
    ap.add_argument('--question-set', default='corpus', choices=QUESTION_SETS, help='corpus (default) | tools (TOOL_CORPUS only) | mixed (both) | kinds (corpus + KIND_CORPUS + tools)')
    ap.add_argument('--lanes', default='', help=f"comma list of question families aimed at a lane ({', '.join(LANE_GROUPS)}); a union with --groups")
    ap.add_argument('--kinds', default='', help=f"comma list of task kinds ({', '.join(KINDS)}); a union with --groups / --lanes; pulls the kind question set in")
    ap.add_argument('--per-kind', type=int, default=None, help='K questions PER kind (stratified across each kind\'s groups; all kinds unless --kinds; replaces --n)')
    ap.add_argument('--concurrency', type=int, default=2)
    ap.add_argument('--case-timeout', type=int, default=900, help='client read deadline per stream (s); the run continues server-side')
    ap.add_argument('--settle', type=int, default=300, help='after a client timeout / stream error, how long to wait for the answer row (s)')
    ap.add_argument('--out', default='', help='JSONL path (default model-bench-<runId>.jsonl)')
    ap.add_argument('--report', default='', help='markdown summary path (default model-bench-<runId>.md)')
    ap.add_argument('--base', default=os.environ.get('DIGBY_E2E_BASE', 'https://digby.ai/api'))
    ap.add_argument('--drop-refused', action='store_true', help='continue without a model the server refuses as a lead (default: exit 2)')
    ap.add_argument('--cleanup-run', default='', metavar='RUN_ID', help="delete every chat of that run (with --dry-run: list them only)")
    ap.add_argument('--continue-from', action='append', default=[], metavar='JSONL',
                    help='extend a FINISHED earlier wave of the SAME --run-id (repeat / comma-list every earlier wave file): questions continue after its last q<idx> and never repeat a template it asked; one ingest then covers every wave')
    ap.add_argument('--start-idx', type=int, default=None, metavar='N',
                    help='number this wave q<N>… (past every idx an earlier wave of the run uses or will use — e.g. 101 beside a running 70-question wave; pair it with --avoid that wave\'s plan)')
    ap.add_argument('--avoid', action='append', default=[], metavar='FILE',
                    help='never ask these questions: a JSON list of texts or a JSONL with question/text (e.g. a still-running wave\'s full plan)')
    ap.add_argument('--pacer-starts', type=int, default=PACER_STARTS, metavar='N',
                    help=f'stream starts per {PACER_WINDOW_S // 60} min (default {PACER_STARTS}; lower it when a second bench shares the 25 / 10 min / IP limiter)')
    ap.add_argument('--relabel', action='append', default=[], metavar='JSONL',
                    help='re-file a FINISHED wave\'s chats under the corpus\' current kinds (a kind= correction after it ran): retitles k:<kind> and rewrites the JSONL (with --dry-run: list only)')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        sys.exit(0 if self_test() else 1)

    def login():
        email, password = os.environ.get('DIGBY_E2E_EMAIL'), os.environ.get('DIGBY_E2E_PASSWORD')
        if not email or not password:
            print('set DIGBY_E2E_EMAIL / DIGBY_E2E_PASSWORD (the canonical test account — never commit credentials)', file=sys.stderr)
            sys.exit(2)
        refused = account_refusal(email, a.base)
        if refused:
            print(refused, file=sys.stderr)
            sys.exit(2)
        try:
            return BenchApi(a.base, email, password)
        except Exception as e:
            print(f'login failed: {e}', file=sys.stderr)
            sys.exit(2)

    if a.cleanup_run:
        if not valid_run_id(a.cleanup_run):
            print(f'bad run id: {a.cleanup_run!r}', file=sys.stderr)
            sys.exit(2)
        api = login()
        hits = run_chats(api, a.cleanup_run)
        if a.dry_run:
            for c in hits:
                print(f"{c.get('id')}  {c.get('title')}")
            print(f'cleanup (dry run): {len(hits)} chat(s) of run {a.cleanup_run}')
            return
        gone = sum(1 for c in hits if c.get('id') and api.delete_chat(c['id']))
        print(f'cleanup: deleted {gone}/{len(hits)} chat(s) of run {a.cleanup_run}')
        sys.exit(0 if gone == len(hits) else 1)

    if a.relabel:
        files = [p for x in a.relabel for p in x.split(',') if p.strip()]
        try:
            by_file = {p: read_records(p) for p in files}
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        recs = [r for rs in by_file.values() for r in rs]
        run_ids = {r.get('run_id') for r in recs}
        if len(run_ids) != 1 or not recs:
            print(f'--relabel reads ONE run\'s records (found run ids {sorted(map(str, run_ids))})', file=sys.stderr)
            sys.exit(2)
        rid = run_ids.pop()
        prior = load_prior_waves(files, rid)
        if not prior['complete']:
            print(f"the wave is not finished (q missing a model: {prior['missing'][:10]}) — relabel only a wave that has exited", file=sys.stderr)
            sys.exit(2)
        plan = relabel_plan(recs)
        for r, k in plan:
            print(f"q{r['q']} {r['spec']}: k:{r.get('kind')} → k:{k}  {r['question'][:70]!r}")
        print(f'relabel: {len(plan)} chat(s) of run {rid} to re-file')
        if a.dry_run or not plan:
            return
        api = login()
        moved = 0
        for r, k in plan:
            title = bench_title(rid, r['q'], r['spec'], k)
            try:
                api._req('PUT', f"/crossmodel/chats/{r['chat_id']}", {'title': title}, timeout=30)
            except Exception as e:
                print(f"  FAILED {r.get('chat_id')}: {type(e).__name__}: {str(e)[:120]}", file=sys.stderr)
                continue
            r['kind'], r['title'] = k, title
            moved += 1
        for path, rs in by_file.items():
            tmp = path + '.relabel.tmp'
            with open(tmp, 'w') as fh:
                fh.write(''.join(json.dumps(r) + '\n' for r in rs))
            os.replace(tmp, path)
        print(f'relabel: retitled {moved}/{len(plan)}')
        sys.exit(0 if moved == len(plan) else 1)

    try:
        models = parse_models(a.models)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    if not models:
        print('--models is required (e.g. --models glm-5.3,deepseek-flash)', file=sys.stderr)
        sys.exit(2)
    run_id = a.run_id or default_run_id()
    if not valid_run_id(run_id):
        print(f'bad --run-id {run_id!r}: letters, digits, . _ - only (≤ 64)', file=sys.stderr)
        sys.exit(2)
    seed = a.seed if a.seed is not None else random.randrange(1, 10_000)
    groups = {g.strip() for g in a.groups.split(',') if g.strip()} or None
    unknown = sorted((groups or set()) - {g for g, _, _ in hc.CORPUS} - {TOOLS_GROUP})
    if unknown:
        print(f"unknown groups: {', '.join(unknown)}", file=sys.stderr)
        sys.exit(2)
    lanes = [x.strip() for x in a.lanes.split(',') if x.strip()]
    kinds = []
    for k in (x.strip() for x in a.kinds.split(',')):
        if k and k not in kinds:
            kinds.append(k)
    per_kind = a.per_kind
    if per_kind is not None:
        if per_kind < 1:
            print('--per-kind must be ≥ 1', file=sys.stderr)
            sys.exit(2)
        if groups or lanes:
            print('--per-kind stratifies by task kind — combine it with --kinds, not --groups / --lanes', file=sys.stderr)
            sys.exit(2)
        kinds = kinds or list(KINDS)
    try:
        # A --kinds run selects by the question's KIND (a kind= flag wins over its group); --groups / --lanes by group.
        explicit_groups = (lane_groups(lanes) | (groups or set())) or None
        question_set, groups = resolve_selection(a.question_set, lanes, groups, kinds)
    except ValueError as e:
        print(str(e), file=sys.stderr)
        sys.exit(2)
    offset, asked, continuing, prior = 0, None, False, None
    if a.continue_from or a.start_idx is not None or a.avoid:
        if not a.run_id:
            print('--continue-from / --start-idx / --avoid need the --run-id of the run they extend', file=sys.stderr)
            sys.exit(2)
    if a.continue_from:
        files = [p for x in a.continue_from for p in x.split(',') if p.strip()]
        try:
            prior = load_prior_waves(files, run_id)
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        if not prior['complete'] and a.start_idx is None:
            print(f"the earlier wave is not finished (q missing a model: {prior['missing'][:10]}) — wait for it to exit, list "
                  'EVERY earlier wave file, or run beside it with --start-idx past its plan and --avoid its plan', file=sys.stderr)
            sys.exit(2)
        if len(prior['tagged']) > 1:
            print('the earlier waves mix k:<kind> and plain titles — not one run', file=sys.stderr)
            sys.exit(2)
        offset, asked, continuing = prior['top'], set(prior['asked']), True
        stale = relabel_plan(prior['records'])
        if stale:
            print(f"warning: {len(stale)} earlier-wave chat(s) carry a kind the corpus now files differently "
                  f"(q{', q'.join(sorted({str(r['q']) for r, _ in stale}, key=int))}) — run --relabel on the finished wave before the ingest", file=sys.stderr)
        print(f'continuing run {run_id} after q{offset} ({len(asked)} question(s) already asked are skipped)')
    if a.avoid:
        try:
            avoid = load_avoid([p for x in a.avoid for p in x.split(',') if p.strip()])
        except ValueError as e:
            print(str(e), file=sys.stderr)
            sys.exit(2)
        asked = (asked or set()) | avoid
        print(f'avoiding {len(avoid)} question(s) from --avoid')
    if a.start_idx is not None:
        if a.start_idx < 1 or a.start_idx <= offset:
            print(f'--start-idx {a.start_idx} must be past q{offset}', file=sys.stderr)
            sys.exit(2)
        offset, continuing = a.start_idx - 1, True
    if per_kind is not None:
        questions = sample_per_kind(per_kind, seed, kinds, question_set, asked)
        short = [k for k in kinds if sum(1 for q in questions if q['kind'] == k) < per_kind]
        if short:
            print(f"note: fewer than {per_kind} eligible question(s) for kind(s) {', '.join(short)}", file=sys.stderr)
    else:
        questions = sample_questions(a.n, seed, explicit_groups, question_set, allow_code='code' in kinds, asked=asked, kinds=kinds or None)
        if len(questions) < a.n:
            print(f'note: the eligible corpus holds only {len(questions)} question(s) for these groups', file=sys.stderr)
    questions = renumber(questions, offset)
    tasks = plan_tasks(questions, models)
    # 2026-10-20 review: only a KIND run titles its chats `… k:<kind>` (and its dry-run lines show the token) — a default
    # run's dry-run output is byte-identical to the pre-kind bench (model-bench.test.sh pins the banner and the lines).
    tag_kinds = run_tags_kinds(kinds, per_kind)
    # The default (corpus, no group filter) banner is byte-identical to before (model-bench.test.sh pins it).
    selection = ((f' · question set {question_set}' if question_set != 'corpus' else '')
                 + (f' · kinds {",".join(kinds)}' if kinds else '')
                 + (f' · per kind {per_kind}' if per_kind is not None else '')
                 + (f' · groups {",".join(sorted(groups))}' if groups and per_kind is None else ''))
    print(f'model-bench run {run_id} · seed {seed}{selection} · {len(questions)} questions × {len(models)} models = {len(tasks)} chats / streams '
          f'(pacing floor ≈ {pacing_floor_minutes(len(tasks))} min)')
    if a.dry_run:
        for k, q in enumerate(questions):
            rot = k % len(models)  # plan_tasks' rotation (list position — a continued wave's idx starts past 1)
            tk = title_kind(q, tag_kinds)
            print(f"q{q['idx']} [{q['group']}{' · ' + ','.join(q['flags']) if q['flags'] else ''}]{' k:' + tk if tk else ''} {q['text']!r} → {', '.join(models[rot:] + models[:rot])}")
        return

    api = login()
    checked = preflight(api, run_id, models)
    refused = {s: err for s, (_, err) in checked.items() if err}
    for s, (canon, err) in checked.items():
        if err:
            print(f'lead model REFUSED: {s} — {err}', file=sys.stderr)
        elif canon != s:
            print(f'lead model {s} is stored as {canon} — benchmarking {canon}')
    if refused and not a.drop_refused:
        print('fix the specs (Account → Admin → Endpoints: an enabled, chat-capable model) or pass --drop-refused', file=sys.stderr)
        sys.exit(2)
    canon_models = []
    for s in models:
        c = checked[s][0]
        if c and c not in canon_models:
            canon_models.append(c)
    if not canon_models:
        print('no benchmarkable model left', file=sys.stderr)
        sys.exit(2)
    tasks = plan_tasks(questions, canon_models)
    # The run id's chats ON THE SERVER (a wave still running has chats past its file): never collide, never mix fields.
    if prior and prior['specs'] != set(canon_models):
        print(f"model field differs from the earlier wave ({', '.join(sorted(prior['specs']))} vs {', '.join(sorted(canon_models))}) — use a new --run-id", file=sys.stderr)
        sys.exit(2)
    why = continuation_refusal(existing_run_facts([c.get('title') for c in run_chats(api, run_id)]),
                               questions[0]['idx'] if questions else None, canon_models, tag_kinds, continuing)
    if why:
        print(f'refused: {why}', file=sys.stderr)
        sys.exit(2)
    wave = f"-q{questions[0]['idx']}" if continuing and questions else ''
    out_path = a.out or f'model-bench-{run_id}{wave}.jsonl'
    report_path = a.report or f'model-bench-{run_id}{wave}.md'
    if a.pacer_starts < 1 or a.pacer_starts > PACER_STARTS:
        print(f'--pacer-starts must be 1..{PACER_STARTS}', file=sys.stderr)
        sys.exit(2)
    pacer = qs.Pacer(max_starts=a.pacer_starts, window_s=PACER_WINDOW_S)
    records, lock, queue = [], threading.Lock(), list(tasks)

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                task = queue.pop(0)
            try:
                r = run_task(api, pacer, task, run_id, a.case_timeout, a.settle, tag_kinds)
            except Exception as e:
                q = task['question']
                r = {'run_id': run_id, 'q': q['idx'], 'group': q['group'], 'kind': q.get('kind'), 'question': q['text'], 'spec': task['spec'],
                     'title': bench_title(run_id, q['idx'], task['spec'], title_kind(q, tag_kinds)), 'harness_error': f'{type(e).__name__}: {str(e)[:160]}', 'attribution': 'harness'}
            with lock:
                records.append(r)
                with open(out_path, 'a') as fh:
                    fh.write(json.dumps(r) + '\n')
                ttft = _ttft_s(r) if r.get('attribution') not in NOT_SENT else None
                print(f"[{len(records)}/{len(tasks)}] q{r['q']} {r['spec']} → {r['attribution']}"
                      + (f" (led by {r.get('model_used')})" if r.get('model_used') and r.get('model_used') != r['spec'] else '')
                      + (f" ttft {ttft}s" if ttft is not None else '')
                      + (f" lane {r.get('lane')}" if r.get('lane') else '')
                      + (f" kind {r.get('kind')}" + (f" (classified {r.get('plan_kind')})" if r.get('plan_kind') and r.get('plan_kind') != r.get('kind') else '') if r.get('kind') else '')
                      + (f" ⚠ {r.get('lead_model_error') or r.get('harness_error')}" if r.get('lead_model_error') or r.get('harness_error') else ''), flush=True)

    threads = [threading.Thread(target=worker) for _ in range(max(1, min(a.concurrency, 4)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    records.sort(key=lambda r: (r.get('q', 0), r.get('spec', '')))
    summary = summarize_models(records, canon_models)
    agreement = kind_agreement(records)
    print()
    print_summary(summary)
    if sum(agreement.values()):
        print(f"kind agreement (question kind vs classified): {agreement['agree']} agree · {agreement['differ']} differ · {agreement['unstamped']} unstamped")
    with open(report_path, 'w') as fh:
        fh.write(markdown_summary(summary, {'run_id': run_id, 'seed': seed, 'questions': len(questions), 'question_set': question_set}, agreement))
    print(f'\nrecords: {out_path} · report: {report_path} · chats KEPT for the ingest:\n'
          f'  bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id {run_id} --judge-panel {BENCH_JUDGE_PANEL}            # dry run (judge v2 panel)\n'
          f'  bash /opt/crossmodel/scripts/framework-audit/prodq.sh model-bench-ingest.js --run-id {run_id} --judge-panel {BENCH_JUDGE_PANEL} --apply    # write the scorecard\n'
          f'  python3 scripts/e2e/model-bench.py --cleanup-run {run_id}                                               # then delete the chats')
    sent = [r for r in records if r.get('attribution') not in NOT_SENT]
    sys.exit(1 if sent and all(r['attribution'] == 'failed' for r in sent) else 0)


if __name__ == '__main__':
    main()
