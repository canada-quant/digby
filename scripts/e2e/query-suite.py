#!/usr/bin/env python3
"""
query-suite.py — randomized LIVE end-to-end query suite for Digby chat
(dynamic roster, 2026-10-03; docs/DYNAMIC_ROSTER_PLAN_2026-10-03.md §7).

Sends a seeded, randomized sample of real questions through the production
SSE stream as ONE account (the canonical prod test account — AGENTS.md
"Canonical prod test account"; never register throwaway accounts) and checks,
per question:
  - routing: the Auto router level + the turn-plan LANE / act / canary
    (metadata.depth.turnPlan + depth.plan.lane on the persisted answer);
  - tools: every tool call the run streamed (agent-activity events, by agent —
    Digby, the Double Checker, council colleagues) and images;
  - latency: time to the first answer chunk and to `complete`;
  - expectations per case (hard ⇒ FAIL, soft ⇒ WARN): acceptable lanes, a
    Quick act that must NOT happen (stakes / contested / code / follow-up in a
    deep session), tools that must run, text the answer must contain, no error.

Categories: quick, standard, checked, research, tools, memory, multi, dig.
Only SAFE / reversible tools are exercised: web search / scrape / web_pipe /
youtube_pipe / browser_task (cloud read), generate_image, create_document /
list_files, remember_fact + forget_fact (cleaned up), get_account_overview /
list_memory. Never schedules, messages, feeds, share links, autonomy or coding
sessions.

COSTS REAL MONEY (each answer is a real model run; a research case can be a
15-minute council). The stream is rate-limited at 25 requests / 10 min per IP —
the pacer keeps ≤ 20 starts per rolling 10 minutes.

Usage:
  DIGBY_E2E_EMAIL=... DIGBY_E2E_PASSWORD=... python3 scripts/e2e/query-suite.py --n 12 --seed 7
  python3 scripts/e2e/query-suite.py --list            # the catalog, no network
  python3 scripts/e2e/query-suite.py --dry-run --n 20  # the sampled cases, no network
  python3 scripts/e2e/query-suite.py --self-test       # the evaluator on synthetic runs
Options: --categories quick,tools,...  --concurrency 2  --out results.jsonl
         --max-research 1  --case-timeout 900  --cleanup (delete the suite's chats
         + its fixed-name file artifacts off the account)
         --base https://digby.ai/api
Exit: 0 = no FAIL, 1 = at least one FAIL, 2 = usage / login error.
"""

import argparse
import http.client
import json
import os
import random
import re
import socket
import ssl
import statistics
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

# Realistic human messages (scripts/e2e/human_corpus.py — owner 2026-10-04: "a lot more generic user human like
# messages with or without required tools"), loaded from this script's own directory.
import importlib.util as _ilu
_hc_spec = _ilu.spec_from_file_location('human_corpus', os.path.join(os.path.dirname(os.path.abspath(__file__)), 'human_corpus.py'))
human_corpus = _ilu.module_from_spec(_hc_spec)
_hc_spec.loader.exec_module(human_corpus)

WEB_TOOLS = ['search_engine', 'web_pipe', 'scrape_as_markdown', 'scrape_batch', 'browser_task']
# 44f0cafc B1 (adversarial review): the X injection's own failure/degradation vocabulary —
# the xUnavailable voice line ("X isn't responding right now…"), the X DATA UNAVAILABLE
# context part and x-mcp's degraded note ("X READ DEGRADED — could not fetch…"). An answer
# that echoes it was TOLD the read failed, so the prefetch cannot have grounded it.
X_PREFETCH_DEGRADED_RE = re.compile(
    r"(?i)\bX (?:DATA UNAVAILABLE|READ DEGRADED|data could not be fetched|isn.t responding|is not responding|"
    r"couldn.t be fetched|couldn.t be reached|could not be reached|read failed|API read failed)"
)


def progress_prefetch_event(t, d):
    """Classify a stream event for prefetch tracking: ('loaded', stage) when an integration's
    pre-run read streamed its Loading/Reading/Checking progress, ('unavailable', 'x') when the
    X injection's degraded follow-up streamed (integration-context.ts xUnavailable — any stage-'x'
    progress that is not a Loading/Reading/Checking message), else None. Pure (44f0cafc B1)."""
    if t != 'progress':
        return None
    stage = str(d.get('stage') or '')
    if stage not in INTEGRATION_STATUS:
        return None
    message = str(d.get('message') or '')
    if message.startswith(('Loading', 'Reading', 'Checking')):
        return ('loaded', stage)
    if stage == 'x':
        return ('unavailable', 'x')
    return None
# A code-intent send ("create a markdown file named ideas.md") attaches a workspace and runs on the
# CODING harness (crossmodel.controller.ts → streamCapabilityRun): its file tools stand in for the
# chat's document tools, and the deliverable hand-off posts the download link.
# Every write-capable tool an integration / platform case must never call on the owner profile.
WRITE_TOOLS = {
    'gmail_send_email', 'gmail_create_draft', 'calendar_create_event', 'docs_create_document', 'docs_append_text',
    'sheets_create_spreadsheet', 'sheets_write_values', 'sheets_append_rows', 'drive_upload_file', 'drive_create_folder',
    'slides_create_presentation', 'slack_post_message', 'asana_create_task', 'asana_update_task', 'x_post', 'imessage_send',
    'notify_user', 'send_email_as_digby', 'send_chat_message', 'send_to_instance', 'dispatch_platform_task', 'computer_task',
    'create_share_link', 'share_canvas', 'share_project', 'set_chat_autonomy', 'create_chat_webhook',
    'start_coding_session', 'remember_fact', 'forget_fact', 'add_knowledge_url', 'add_knowledge_note', 'set_preferences',
    'delete_chat', 'delete_project', 'delete_canvas', 'delete_document',
}
TOOL_EQUIV = {'create_document': {'write_file'}, 'update_document': {'edit_file', 'write_file'}}

# The fixed filenames the suite's own prompts NAME (ticket 1f67492f). A create ask lands a
# GeneratedFile row on the ACCOUNT — bare chatId column, NO FK (schema.prisma), so --cleanup's
# chat deletion never cascades to it. The 2026-10-07 01:19Z run (37556487363) created rate.md
# there (create_document, a WARN), and every later search-then-document correctly found it
# (list_files) and REFRESHED it (update_document — its own contract: "use when the user asks
# to change, extend, or correct a file you created earlier") while the chain's hard
# create_document step starved → false FAILs on the 03:15Z and 06:47Z re-runs. (The 2026-10-06
# 22:14Z run's write_file landed as a chat-scoped hand-off ChatFile, which chat cleanup DOES
# delete — the surviving row was the GeneratedFile one.) 'Packing list.md' is the fixed TITLE
# tpl_tool_document names (self-audit D1: a live probe showed it stranded on the account
# 2026-10-07T02:00Z while the sweep skipped it — the case's refresh twin is the same
# false-FAIL class). LIMITATION: the model INVENTS filenames for the doc-format asks
# (tpl_tool_doc_format: barista-cover-letter.docx etc.) — a name-based sweep cannot cover
# those; a leftover there stays and the case adjudicates on its own merits. The test profile
# sweeps exactly these names off the account before a run and again on --cleanup (never the
# owner profile — pinned); a same-name collision that survives a missed sweep is adjudicated
# a WARN, never a nightly FAIL.
SUITE_FILENAMES = {'rate.md', 'ideas.md', 'notes.txt', 'budget.xlsx', 'week.xlsx', 'groceries.xlsx', 'packing list.md'}

def suite_file_row(row):
    """True when a generated-file row is one of the suite's own fixed-name leftovers (the
    account-level rows chat cleanup cannot reach). Case-insensitive on the exact names."""
    return isinstance(row, dict) and str(row.get('filename') or '').strip().lower() in SUITE_FILENAMES

def suite_memory_key(key):
    """True when a userMemory fact key is one of the SUITE'S OWN (ticket 6fd4663a — the
    memory half of the 1f67492f file-sweep problem: a chat delete never touches the
    account-level userMemory blob, so the suite's remember/forget cases left durable facts
    and __rejections topic bans on the shared test account). The suite's vocabulary is the
    'fav' slots + city/nickname, stored as the extractor writes them: 'favourite tea',
    'favourite_tea', 'fav tea', 'favourite-tea'… — matched on the fav-phrase prefix after
    normalising separators. __ bookkeeping keys (__rejections = the do-not-mention bans)
    are the suite's too — this account is the suite's own, but ONLY these shapes go: any
    other fact is the account's real memory and stays."""
    if not isinstance(key, str):
        return False
    k = key.strip().lower()
    if k.startswith('__'):
        return True
    kn = k.replace('_', ' ').replace('-', ' ')
    return bool(re.match(r'^(favourite|favorite|fav)\s+(colour|color|tea|board game|season|spice|bird)\b', kn))

# ── slot vocabularies (randomized fill-ins) ──────────────────────────────────
SLOTS = {
    'city': ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Halifax', 'London', 'Tokyo', 'Sydney', 'Paris', 'Mexico City', 'Nairobi', 'Reykjavik'],
    'cur_pair': [('USD', 'CAD'), ('EUR', 'USD'), ('GBP', 'JPY'), ('CAD', 'MXN'), ('AUD', 'EUR'), ('CHF', 'CAD')],
    'amount': ['15', '120', '2,500', '49.99', '750', '10,000'],
    'word': ['sonder', 'petrichor', 'ephemeral', 'laconic', 'serendipity', 'ubiquitous', 'quixotic', 'liminal'],
    'league': ['NBA', 'NHL', 'Stanley Cup', 'Premier League', 'World Series', 'Champions League'],
    'units': [('ounces', 'pound'), ('teaspoons', 'tablespoon'), ('feet', 'mile'), ('millilitres', 'cup'), ('centimetres', 'inch')],
    'topic': ['autumn rain', 'a lighthouse at night', 'morning coffee', 'a city bus', 'snow on pine trees', 'an old library'],
    'concept': ['compound interest', 'photosynthesis', 'how vaccines train the immune system', 'what a blockchain is', 'why the sky is blue', 'inflation'],
    'business': ['dog-walking service', 'vegan bakery', 'bike repair shop', 'tutoring startup', 'plant nursery'],
    'sentence': ["hey can u send me the file asap", "we gotta push the meeting cuz stuff came up", "thx for the help, it was super useful"],
    'drug_pair': [('ibuprofen', 'warfarin'), ('St John\'s wort', 'sertraline'), ('alcohol', 'acetaminophen'), ('grapefruit juice', 'atorvastatin')],
    'debt': ['a 7% car loan', 'my student loans at 4.5%', 'a credit card at 21%'],
    'savings': ['$8,000', '$25,000', '$3,000'],
    'contested': ['Was Pierre Trudeau good for Canada?', 'Was the 1995 Quebec referendum handled fairly by Ottawa?', 'Should nuclear power be part of Canada\'s climate plan?', 'Was Winston Churchill a hero or a villain?'],
    'research': [
        'Explain the history of why Canadians are for or against Quebec sovereignty, with the main perspectives on each side.',
        'Compare the main options for home battery storage in Canada in 2026 across price, capacity, warranty and reliability.',
        'Research the evidence on four-day work weeks: what have the large trials found about productivity and wellbeing? Cite sources.',
        'Give me an in-depth analysis of how the Bank of Canada sets interest rates and how that has changed since 2020.',
    ],
    'animal': ['red fox', 'sea otter', 'barn owl', 'moose', 'corgi', 'octopus'],
    'hat': ['top hat', 'tiny crown', 'knitted toque', 'pirate hat', 'sombrero'],
    'trip': ['camping trip', 'ski weekend', 'beach getaway', 'city break'],
    'fav': [('colour', 'teal'), ('tea', 'oolong'), ('board game', 'Catan'), ('season', 'autumn'), ('spice', 'saffron'), ('bird', 'kingfisher')],
    'image_url': [
        'https://www.google.com/images/branding/googlelogo/2x/googlelogo_color_272x92dp.png',
        'https://www.python.org/static/img/python-logo.png',
    ],
    'page': [('https://news.ycombinator.com', 'the top 3 story titles'), ('https://www.python.org', 'the latest Python release mentioned'), ('https://en.wikipedia.org/wiki/Main_Page', "today's featured article title")],
    'sheet': [('Month, Revenue, Costs', 'January to June', 'budget.xlsx'), ('Day, Steps, Sleep hours', 'Monday to Sunday', 'week.xlsx'), ('Item, Qty, Unit price', 'six grocery items', 'groceries.xlsx')],
    'doc_kind': [('docx', 'a two-paragraph cover letter for a barista job'), ('pdf', 'a one-page agenda for a team offsite'), ('csv', 'a list of 5 Canadian provinces with their capitals')],
    'pop_pair': [('Toronto', 'Vancouver'), ('Calgary', 'Ottawa'), ('Montreal', 'Halifax')],
    'banner': ['a mountain lake at sunrise', 'a cozy reading nook', 'a neon city street in the rain'],
    'wiki_pair': [('the Eiffel Tower', 'the Statue of Liberty'), ('Toronto', 'Montreal'), ('the Python programming language', 'the Java programming language')],
}


# Chat tool families (inventory 2026-10-04: CHAT_ORCH_TOOLS in coding/agent.ts) → the tools that count as
# exercising them. `summarize` reports which families a run covered.
TOOL_FAMILIES = {
    'web search / read': ['search_engine', 'scrape_as_markdown', 'scrape_batch', 'web_pipe'],
    'browser': ['browser_task'],
    'video': ['youtube_pipe'],
    'images (fetch)': ['fetch_image'],
    'images (generate)': ['generate_image'],
    'documents': ['create_document', 'read_document', 'update_document', 'list_files'],
    'delegation': ['delegate', 'delegate_parallel'],
    'ask the user': ['ask_user'],
    'memory': ['remember_fact', 'forget_fact', 'list_memory', 'search_memory'],
    'Files artifacts (canvases)': ['list_canvases', 'get_canvas', 'update_canvas'],
    'schedules (this chat)': ['schedule_message', 'cancel_schedule', 'pause_schedule', 'list_schedules'],
    'chat instructions': ['set_chat_instructions'],
    'account / platform reads': ['get_account_overview', 'get_spend', 'list_knowledge_documents', 'get_preferences', 'search_chats', 'list_chats', 'telegram_connect_link'],
    'Gmail': ['gmail_search', 'gmail_get_message'],
    'Calendar': ['calendar_list_events'],
    'Drive / Sheets / Docs': ['drive_search', 'sheets_get_data', 'drive_get_doc'],
    'GitHub': ['list_github_repos', 'github_list_prs', 'github_list_issues', 'github_search_code', 'github_get_issue'],
    'Slack': ['slack_list_channels', 'slack_search', 'slack_get_channel_history'],
    'Asana': ['asana_list_tasks', 'asana_list_projects', 'asana_search'],
    'Xero': ['xero_get_organisation', 'xero_get_invoices', 'xero_get_contacts'],
    'Plaid': ['plaid_get_accounts', 'plaid_get_balances'],
    'X': ['x_get_trends', 'x_search', 'x_get_user_profile'],
    'iMessage': ['imessage_list_chats'],
}
# Never exercised by the suite, on purpose (each is external, irreversible, or drives a real device).
EXCLUDED_BY_DESIGN = {
    'integration writes (send email / post Slack / create event / Asana task / X post / iMessage send / Drive+Docs writes)': 'external effect on real services — needs a per-run owner OK',
    'computer_task': 'drives a real paired Mac',
    'fill_pdf_form': 'needs a fillable PDF fixture',
    'search_code_semantic': 'needs a workspace',
    'notify_user / send_email_as_digby / send_chat_message / send_to_instance / dispatch_platform_task': 'messages leave the chat',
    'share links / autonomy / webhooks / project sharing': 'NEVER_AUTONOMOUS or card-gated, external effect',
    'start_coding_session / import_repo': 'starts long-running background work',
    'delete_* tools': 'ask-first, destructive',
}


def pick(rng, key):
    return rng.choice(SLOTS[key])


# Each template returns a case dict. `turns` = the user messages in ONE chat;
# per-turn expectations ride `expect` (list aligned with turns).
def tpl_quick_weather(rng):
    c = pick(rng, 'city')
    return {'category': 'quick', 'name': 'weather', 'turns': [f"what's the weather in {c} right now?"],
            'expect': [{'lanes': ['quick'], 'tools_any': WEB_TOOLS, 'quick_act': True}]}

def tpl_quick_currency(rng):
    a, b = pick(rng, 'cur_pair')
    return {'category': 'quick', 'name': 'currency', 'turns': [f"convert {pick(rng, 'amount')} {a} to {b}"],
            'expect': [{'lanes': ['quick', 'standard'], 'tools_any': WEB_TOOLS}]}

def tpl_quick_time(rng):
    return {'category': 'quick', 'name': 'time', 'turns': [f"what time is it in {pick(rng, 'city')} right now?"],
            'expect': [{'lanes': ['quick', 'standard']}]}

def tpl_quick_define(rng):
    return {'category': 'quick', 'name': 'define', 'turns': [f"what does the word '{pick(rng, 'word')}' mean?"],
            'expect': [{'lanes': ['quick', 'standard']}]}

def tpl_quick_sports(rng):
    return {'category': 'quick', 'name': 'sports', 'turns': [f"who won the most recent {pick(rng, 'league')}?"],
            'expect': [{'lanes': ['quick', 'standard'], 'tools_any': WEB_TOOLS}]}

def tpl_quick_units(rng):
    a, b = pick(rng, 'units')
    return {'category': 'quick', 'name': 'units', 'turns': [f"how many {a} are in a {b}?"],
            'expect': [{'lanes': ['quick', 'standard']}]}

def tpl_standard_haiku(rng):
    return {'category': 'standard', 'name': 'haiku', 'turns': [f"write a haiku about {pick(rng, 'topic')}"],
            'expect': [{'lanes': ['standard', 'quick'], 'no_quick_act': False}]}

def tpl_standard_explain(rng):
    return {'category': 'standard', 'name': 'explain', 'turns': [f"explain {pick(rng, 'concept')} to a 12-year-old in three sentences"],
            'expect': [{'lanes': ['standard', 'quick', 'checked']}]}

def tpl_standard_names(rng):
    return {'category': 'standard', 'name': 'names', 'turns': [f"give me 5 name ideas for a {pick(rng, 'business')}"],
            'expect': [{'lanes': ['standard', 'quick']}]}

def tpl_standard_rewrite(rng):
    return {'category': 'standard', 'name': 'rewrite', 'turns': [f"rewrite this to sound more professional: \"{pick(rng, 'sentence')}\""],
            'expect': [{'lanes': ['standard', 'quick']}]}

def tpl_standard_code(rng):
    return {'category': 'standard', 'name': 'code', 'turns': ["write a python function that checks whether a string is a palindrome, ignoring spaces and case"],
            'expect': [{'lanes': ['standard', 'quick', 'checked'], 'no_quick_act': True}]}

def tpl_checked_drugs(rng):
    a, b = pick(rng, 'drug_pair')
    return {'category': 'checked', 'name': 'drug-interaction', 'turns': [f"is it safe to take {a} together with {b}?"],
            'expect': [{'lanes': ['checked', 'research', 'standard'], 'no_quick_act': True}]}

def tpl_checked_money(rng):
    return {'category': 'checked', 'name': 'money', 'turns': [f"should I pay off {pick(rng, 'debt')} or invest in an index fund first? I have {pick(rng, 'savings')} saved."],
            'expect': [{'lanes': ['checked', 'standard', 'research'], 'no_quick_act': True}]}

def tpl_checked_math(rng):
    v1, v2 = rng.choice([(80, 100), (60, 90), (70, 110)])
    return {'category': 'checked', 'name': 'math', 'turns': [f"Two trains leave cities 420 km apart at the same time heading toward each other at {v1} km/h and {v2} km/h. How long until they meet, and how far does each travel? Show your working."],
            'expect': [{'lanes': ['checked', 'standard', 'quick'], 'answer_regex': [r'\d']}]}

def tpl_checked_contested(rng):
    return {'category': 'checked', 'name': 'contested', 'turns': [pick(rng, 'contested')],
            'expect': [{'lanes': ['checked', 'research', 'standard'], 'no_quick_act': True}]}

def tpl_research(rng):
    return {'category': 'research', 'name': 'research', 'turns': [pick(rng, 'research')],
            'expect': [{'lanes': ['research', 'checked'], 'no_quick_act': True, 'tools_any': WEB_TOOLS}]}

def tpl_tool_image(rng):
    return {'category': 'tools', 'name': 'generate-image', 'turns': [f"generate an image of a {pick(rng, 'animal')} wearing a {pick(rng, 'hat')}, watercolor style"],
            'expect': [{'tools_any': ['generate_image'], 'images_generated': 1}]}

# A "document" ask is doctrine-legitimately served THREE ways (92857a41 + 1da06d4e): the chat
# playbook routes "a document they can open" to create_canvas, create_document's own description
# claims every "document" ask, and the answer's own inline [CANVAS] marker (the create_canvas
# description's PREFERRED route when writing an answer) materializes the same artifact with no
# tool call at all. All three land as an artifact in Files (canvases were folded into the Files
# pane 2026-09-23). The suite accepts any of them, prefers the dedicated file tool (a canvas —
# tool or marker — is a WARN), and hard-checks that an artifact actually landed.
def tpl_tool_document(rng):
    return {'category': 'tools', 'name': 'create-document', 'turns': [f"create a short markdown document titled 'Packing list' with a packing list for a weekend {pick(rng, 'trip')}"],
            'expect': [{'tools_any': ['create_document', 'create_canvas'], 'tools_prefer': ['create_document'], 'artifact': 1}]}

def tpl_tool_files(rng):
    return {'category': 'tools', 'name': 'list-files', 'turns': ["list the files you have generated for me so far"],
            'expect': [{'tools_any': ['list_files']}]}

# The [YOUR INTEGRATION STATUS] block rides EVERY signed-in turn's context (chat-context.ts; 5-min cache +
# invalidation on connect/disconnect), so a correct grounded answer can carry no tool call — the same
# adjudication the integrations-category twin got (runbook "Prefetch counts as grounding"). The tool is
# preferred only; what the case still demands is a real answer naming the state and no writes (ticket 92857a41).
def tpl_tool_account(rng):
    return {'category': 'tools', 'name': 'account-overview', 'turns': ["what integrations and connected accounts do I have set up in Digby?"],
            'expect': [{'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']}]}

def tpl_tool_webpipe(rng):
    a, b = pick(rng, 'wiki_pair')
    return {'category': 'tools', 'name': 'multi-page-read', 'turns': [f"read the Wikipedia articles on {a} and {b} and tell me which is older and by how many years"],
            'expect': [{'tools_any': WEB_TOOLS, 'answer_regex': [r'\d']}]}

def tpl_tool_youtube(rng):
    return {'category': 'tools', 'name': 'youtube', 'turns': ["summarize this YouTube video in three bullet points: https://www.youtube.com/watch?v=dQw4w9WgXcQ"],
            'expect': [{'tools_any': ['youtube_pipe', 'scrape_as_markdown', 'web_pipe', 'search_engine'], 'tools_prefer': ['youtube_pipe']}]}

def tpl_tool_browser(rng):
    return {'category': 'tools', 'name': 'browser', 'turns': ["use the browser to open https://example.com and tell me the exact page heading"],
            'expect': [{'tools_any': ['browser_task', 'scrape_as_markdown', 'web_pipe'], 'tools_prefer': ['browser_task'], 'answer_regex': [r'(?i)example domain']}]}

def tpl_tool_fetch_image(rng):
    return {'category': 'tools', 'name': 'fetch-image', 'turns': [f"look at this image and describe what it shows: {pick(rng, 'image_url')}"],
            'expect': [{'tools_any': ['fetch_image', 'scrape_as_markdown', 'web_pipe'], 'tools_prefer': ['fetch_image']}]}

def tpl_tool_scrape(rng):
    url, what = pick(rng, 'page')
    return {'category': 'tools', 'name': 'scrape-page', 'turns': [f"open {url} and tell me {what}"],
            'expect': [{'tools_any': ['scrape_as_markdown', 'web_pipe', 'browser_task', 'scrape_batch']}]}

def tpl_tool_sheet(rng):
    cols, rows, fname = pick(rng, 'sheet')
    return {'category': 'tools', 'name': 'spreadsheet', 'turns': [f"make me a spreadsheet called {fname} with columns {cols} and one row per {rows} — sample numbers are fine"],
            'expect': [{'tools_any': ['create_document']}]}

def tpl_tool_doc_format(rng):
    fmt, what = pick(rng, 'doc_kind')
    return {'category': 'tools', 'name': f'document-{fmt}', 'turns': [f"create a {fmt} file with {what}"],
            'expect': [{'tools_any': ['create_document']}]}

def tpl_tool_doc_chain(rng):
    return {'category': 'tools', 'name': 'document-create-then-update', 'turns': [
        f"create a markdown file named ideas.md listing 3 weekend ideas for a {pick(rng, 'trip')}",
        "add a fourth idea to that file and keep the other three",
    ], 'expect': [
        {'tools_any': ['create_document']},
        {'tools_any': ['update_document', 'create_document']},
    ]}

def tpl_tool_search_then_doc(rng):
    a, b = pick(rng, 'cur_pair')
    return {'category': 'tools', 'name': 'search-then-document', 'turns': [f"look up today's {a} to {b} exchange rate and save it in a short markdown note called rate.md"],
            'expect': [{'tools_all': [WEB_TOOLS, ['create_document']]}]}

def tpl_tool_compare_numbers(rng):
    a, b = pick(rng, 'pop_pair')
    return {'category': 'tools', 'name': 'search-and-compute', 'turns': [f"what are the current metro populations of {a} and {b}, and what is the ratio between them?"],
            'expect': [{'tools_any': WEB_TOOLS, 'answer_regex': [r'\d']}]}

def tpl_tool_banner(rng):
    return {'category': 'tools', 'name': 'generate-image-wide', 'turns': [f"generate a wide 16:9 banner image of {pick(rng, 'banner')}"],
            'expect': [{'tools_any': ['generate_image'], 'images_generated': 1}]}

def tpl_tool_canvases(rng):
    return {'category': 'tools', 'name': 'list-canvases', 'turns': ["list the canvases I have saved"],
            'expect': [{'tools_any': ['list_canvases']}]}

def tpl_tool_memory_list(rng):
    return {'category': 'tools', 'name': 'what-do-you-remember', 'turns': ["what do you remember about me? list the facts you have stored"],
            'expect': [{'tools_any': ['list_memory', 'search_memory', 'get_account_overview']}]}

def tpl_tool_news(rng):
    return {'category': 'tools', 'name': 'news', 'turns': [rng.choice(["what are today's top news headlines in Canada?", "what's the latest news about the Bank of Canada?", "any big tech news today?"])],
            'expect': [{'tools_any': WEB_TOOLS}]}

def tpl_tool_read_back(rng):
    return {'category': 'tools', 'name': 'document-create-then-read', 'turns': [
        f"create a text file named notes.txt with three short lines about {pick(rng, 'topic')}",
        "read that file back to me and tell me exactly how many lines it has",
    ], 'expect': [
        {'tools_any': ['create_document']},
        {'tools_any': ['read_document', 'list_files'], 'tools_prefer': ['read_document']},
    ]}

def tpl_tool_delegate(rng):
    a, b = pick(rng, 'pop_pair')
    return {'category': 'tools', 'name': 'parallel-research', 'turns': [f"research these two in parallel and give me one line on each: the current mayor of {a} and the current mayor of {b}"],
            'expect': [{'tools_any': ['delegate_parallel', 'delegate'] + WEB_TOOLS, 'tools_prefer': ['delegate_parallel', 'delegate']}]}

def tpl_ask_user(rng):
    return {'category': 'tools', 'name': 'ambiguous-ask', 'turns': [rng.choice(["book me something nice for Friday", "help me pick between the two options", "send it to the usual place"])],
            'expect': [{'ask_ok': True, 'tools_prefer': ['ask_user']}]}

# Files artifacts + platform: the test account only (they write to the account — reversible, then cleaned up).
# Canvases were folded into the Files pane on 2026-09-23 (AGENTS.md "Artifacts folded into Files"): an artifact
# lands in Files either as a canvas ([CANVAS] block — still how an HTML page is kept; create_document makes no
# HTML) or as a generated file, so the case accepts either path and the matching list / edit tools.
def tpl_files_artifact(rng):
    page = rng.choice(['a button that counts clicks', 'a tip calculator', 'a countdown timer to New Year'])
    return {'category': 'files', 'name': 'artifact-create-list-edit', 'turns': [
        f"make me a tiny single-file HTML page with {page} that I can keep in my Files",
        "list what's saved in my Files from this chat",
        "in that page, make the main button blue",
    ], 'expect': [
        {'artifact': 1},
        {'tools_any': ['list_files', 'list_canvases']},
        {'tools_any': ['update_canvas', 'get_canvas', 'update_document', 'read_document'], 'tools_prefer': ['update_canvas', 'update_document']},
    ]}

def tpl_platform_reads(rng):
    q, tools = rng.choice([
        ("do I have any scheduled messages or reminders set up?", ['list_schedules']),
        ("what do I have set up in my Digby account?", ['get_account_overview']),
        ("how much have my Digby runs cost this week?", ['get_spend']),
        ("what documents are in my knowledge base?", ['list_knowledge_documents', 'get_account_overview']),
        ("what are my Digby preferences set to?", ['get_preferences', 'get_account_overview']),
        ("find my earlier chat about a haiku", ['search_chats', 'list_chats']),
        ("give me the link to connect Telegram so you can message me", ['telegram_connect_link']),
    ])
    return {'category': 'platform', 'name': 'platform-read', 'turns': [q], 'expect': [{'tools_any': tools}]}

def tpl_schedule_cancel(rng):
    return {'category': 'platform', 'name': 'schedule-then-cancel', 'turns': [
        "in this chat, remind me in 3 hours to stretch",
        "actually cancel that reminder",
    ], 'expect': [
        {'tools_any': ['schedule_message']},
        {'tools_any': ['cancel_schedule', 'pause_schedule'], 'tools_prefer': ['cancel_schedule']},
    ]}

def tpl_chat_instructions(rng):
    return {'category': 'platform', 'name': 'chat-instructions', 'turns': [
        "for the rest of this chat, always answer in exactly one sentence",
        f"explain {pick(rng, 'concept')}",
    ], 'expect': [
        {'tools_any': ['set_chat_instructions']},
        {'answer_regex': [r'^[^\n]{1,400}$']},
    ]}

def tpl_x_public(rng):
    # The controller's X prefetch (integration-context.ts) fires on the same 'search X'
    # regex intent BEFORE the run and injects the posts into the context — the integrations
    # twins already take that as grounding (runbook "Prefetch counts as grounding"), and so
    # does this tools-category twin: a no-tool answer grounded by the injected data is a
    # WARN naming the prefetch, not a FAIL (44f0cafc — the 2026-10-07 nightly's zero-tool
    # answer WAS the injected site:x.com SERP; its caveat paraphrased x-mcp's provenance note).
    return {'category': 'tools', 'name': 'x-trends', 'turns': [rng.choice(["what's trending on X (Twitter) right now?", "search X for the latest posts about the Toronto Blue Jays"])],
            'expect': [{'tools_any': ['x_get_trends', 'x_search'] + WEB_TOOLS, 'tools_prefer': ['x_get_trends', 'x_search'], 'prefetch_ok': 'x'}]}

# ── INTEGRATIONS (READ-ONLY) — run on the OWNER profile (the account with connected services) ──
# The controller PRE-FETCHES integration data on a regex intent before the run (integration-context.ts —
# progress stages google / github / slack / asana / xero / plaid / x / imessage) and injects it into the
# context, so a grounded answer may carry NO tool call (2026-10-04 owner run: Plaid accounts, today's Drive
# files). A case passes when a read tool of its family ran OR its family's prefetch stage streamed.
def _integ(name, requires, prompt, tools, prefer=None):
    return {'category': 'integrations', 'name': name, 'requires': requires, 'turns': [prompt],
            'expect': [{'tools_any': tools, **({'tools_prefer': prefer} if prefer else {}), 'read_only': True,
                        **({'prefetch_ok': requires} if requires else {})}]}

def tpl_int_gmail(rng):
    who = rng.choice(['GitHub', 'Google', 'Amazon', 'LinkedIn', 'Stripe', 'Apple'])
    return _integ('gmail-search', 'google', f"search my Gmail for the most recent email from {who} and tell me only its subject line and date", ['gmail_search', 'gmail_get_message'], ['gmail_search'])

def tpl_int_calendar(rng):
    when = rng.choice(['today', 'tomorrow', 'this week', 'next Monday'])
    return _integ('calendar-list', 'google', f"what's on my Google Calendar {when}?", ['calendar_list_events'])

def tpl_int_drive(rng):
    return _integ('drive-search', 'google', rng.choice(["what are the 3 most recently modified files in my Google Drive?", "find a Google Sheet in my Drive and tell me its title and first row"]), ['drive_search', 'sheets_get_data', 'drive_get_doc'], ['drive_search'])

def tpl_int_github(rng):
    prompt, tools = rng.choice([
        ("list my 5 most recently updated GitHub repositories", ['list_github_repos', 'github_search_code', 'github_list_issues', 'github_list_prs']),
        ("what are the open pull requests in example-org/crossmodel? just the titles", ['github_list_prs']),
        ("list the 3 newest open issues in example-org/crossmodel", ['github_list_issues']),
        ("search the code in example-org/crossmodel for quickLaneEligibility and tell me which file defines it", ['github_search_code']),
    ])
    return _integ('github-read', 'github', prompt, tools)

def tpl_int_slack(rng):
    prompt, tools = rng.choice([
        ("which Slack channels am I in?", ['slack_list_channels']),
        ("search my Slack for messages mentioning 'deploy' and summarize the latest one", ['slack_search']),
    ])
    return _integ('slack-read', 'slack', prompt, tools)

def tpl_int_asana(rng):
    prompt, tools = rng.choice([
        ("what Asana tasks are assigned to me? list up to 5", ['asana_list_tasks', 'asana_search']),
        ("list my Asana projects", ['asana_list_projects']),
    ])
    return _integ('asana-read', 'asana', prompt, tools)

def tpl_int_xero(rng):
    prompt, tools = rng.choice([
        ("what's the name of my Xero organisation?", ['xero_get_organisation']),
        ("list my 3 most recent Xero invoices — number, contact and total only", ['xero_get_invoices']),
    ])
    return _integ('xero-read', 'xero', prompt, tools)

def tpl_int_plaid(rng):
    return _integ('plaid-read', 'plaid', "which bank accounts do I have connected? names and types only, no numbers", ['plaid_get_accounts', 'plaid_get_balances'])

def tpl_int_x(rng):
    return _integ('x-read', 'x', "show me the profile summary of my X account", ['x_get_user_profile', 'x_search'])

def tpl_int_imessage(rng):
    return _integ('imessage-read', 'imessage', "list the names of my 3 most recent iMessage conversations — names only, no message text", ['imessage_list_chats'])

def tpl_int_overview(rng):
    # The [YOUR INTEGRATION STATUS] block already lists every connection — answering from it is right;
    # get_account_overview is preferred only (soft).
    return {'category': 'integrations', 'name': 'account-overview', 'requires': None, 'turns': ["which integrations do I have connected right now?"],
            'expect': [{'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']}]}

def tpl_memory(rng):
    thing, value = pick(rng, 'fav')
    return {'category': 'memory', 'name': 'remember-recall-forget', 'turns': [
        f"please remember that my favourite {thing} is {value}.",
        f"what is my favourite {thing}?",
        f"please forget my favourite {thing} — remove it from your memory.",
    ], 'fresh_chat_turns': [1], 'expect': [
        {'tools_any': ['remember_fact']},
        {'answer_regex': ['(?i)' + re.escape(value)]},
        {'tools_any': ['forget_fact']},
    ]}

def tpl_multi_hysteresis(rng):
    return {'category': 'multi', 'name': 'follow-up-in-deep-session', 'turns': [
        pick(rng, 'contested'),
        "and when did that debate start?",
    ], 'expect': [
        {'lanes': ['checked', 'research', 'standard'], 'no_quick_act': True},
        {'no_quick_act_if_prior_deep': True},
    ]}

def tpl_dig(rng):
    c = pick(rng, 'city')
    return {'category': 'dig', 'name': 'quick-then-dig-deeper', 'turns': [f"what's the weather in {c} today?"], 'dig': True,
            'expect': [{'lanes': ['quick', 'standard'], 'tools_any': WEB_TOOLS}], 'expect_dig': {'rung_preset': 'thinking'}}

CATALOG = {
    'quick': [tpl_quick_weather, tpl_quick_currency, tpl_quick_time, tpl_quick_define, tpl_quick_sports, tpl_quick_units],
    'standard': [tpl_standard_haiku, tpl_standard_explain, tpl_standard_names, tpl_standard_rewrite, tpl_standard_code],
    'checked': [tpl_checked_drugs, tpl_checked_money, tpl_checked_math, tpl_checked_contested],
    'research': [tpl_research],
    'tools': [tpl_tool_image, tpl_tool_document, tpl_tool_files, tpl_tool_account, tpl_tool_webpipe, tpl_tool_youtube, tpl_tool_browser,
              tpl_tool_fetch_image, tpl_tool_scrape, tpl_tool_sheet, tpl_tool_doc_format, tpl_tool_doc_chain, tpl_tool_search_then_doc,
              tpl_tool_compare_numbers, tpl_tool_banner, tpl_tool_canvases, tpl_tool_memory_list, tpl_tool_news,
              tpl_tool_read_back, tpl_tool_delegate, tpl_ask_user, tpl_x_public],
    'memory': [tpl_memory],
    'files': [tpl_files_artifact],
    'platform': [tpl_platform_reads, tpl_schedule_cancel, tpl_chat_instructions],
    'integrations': [tpl_int_gmail, tpl_int_calendar, tpl_int_drive, tpl_int_github, tpl_int_slack, tpl_int_asana,
                     tpl_int_xero, tpl_int_plaid, tpl_int_x, tpl_int_imessage, tpl_int_overview],
    'multi': [tpl_multi_hysteresis],
    'dig': [tpl_dig],
    'human': [human_corpus.human_case],
    'human_thread': [human_corpus.thread_case],
}
DEFAULT_WEIGHTS = {'quick': 4, 'standard': 3, 'checked': 3, 'research': 1, 'tools': 6, 'memory': 1, 'multi': 1, 'dig': 1,
                   'files': 1, 'platform': 2, 'integrations': 4, 'human': 8, 'human_thread': 3}
# The TEST profile (the canonical prod test account) runs everything except integrations (it has none connected);
# the OWNER profile runs ONLY read-only integration + platform-read cases on the owner's own account and always
# deletes its chats — never memory writes, files, images, canvases, schedules or anything external.
PROFILES = {
    'test': {'email_env': 'DIGBY_E2E_EMAIL', 'password_env': 'DIGBY_E2E_PASSWORD',
             'categories': ['quick', 'standard', 'checked', 'research', 'tools', 'memory', 'multi', 'dig', 'files', 'platform', 'human', 'human_thread']},
    'owner': {'email_env': 'DIGBY_E2E_OWNER_EMAIL', 'password_env': 'DIGBY_E2E_OWNER_PASSWORD',
              'categories': ['integrations'], 'force_cleanup': True},
}
OWNER_SAFE_PLATFORM_READ = True  # tpl_platform_reads only reads; listed here so the self-test pins it
# Integrations the suite never tests, whatever their status says (owner 2026-10-04: "xero isn't configured that is
# fine drop that" — a stale Xero row reads connected but every call 403s; that is expected, not a regression).
SKIP_INTEGRATIONS = {'xero'}
# Integrations the suite can check before sampling (GET /crossmodel/<x>/status → data.connected).
INTEGRATION_STATUS = ['google', 'github', 'slack', 'asana', 'xero', 'plaid', 'x', 'imessage', 'telegram']


def sample_cases(n, seed, categories, max_research, connected=None):
    """connected: the set of connected integrations (None = assume all — dry runs); a template whose
    `requires` is not connected is never sampled."""
    rng = random.Random(seed)
    cats = [c for c in categories if c in CATALOG]
    weights = [DEFAULT_WEIGHTS.get(c, 1) for c in cats]
    cases, research = [], 0
    guard = 0
    while len(cases) < n and guard < n * 20:
        guard += 1
        cat = rng.choices(cats, weights=weights)[0]
        if cat == 'research' and research >= max_research:
            continue
        used = {(c['category'], c['name']) for c in cases}
        usable = [fn for fn in CATALOG[cat] if connected is None or fn(random.Random(0)).get('requires') in (None, *connected)]
        if not usable:
            continue
        fresh_fns = [fn for fn in usable if (cat, fn(random.Random(0))['name']) not in used]
        case = rng.choice(fresh_fns or usable)(rng)
        if any(c['turns'] == case['turns'] for c in cases):
            continue
        research += 1 if cat == 'research' else 0
        cases.append(case)
    # research last (the longest runs); multi-turn cases keep their turn order inside the case
    cases.sort(key=lambda c: 1 if c['category'] == 'research' else 0)
    for k, c in enumerate(cases):
        c['id'] = f"{k + 1:02d}-{c['category']}-{c['name']}"
    return cases


# ── HTTP ─────────────────────────────────────────────────────────────────────
CONNECT_RETRY_DELAYS_S = (3, 10)  # 2026-10-04 seed 6060: an SSL handshake timeout during a deploy swap failed a case


def connect_failure_retryable(err, method):
    """True when `err` failed BEFORE the server could act on the request, so a retry cannot double-act.
    urllib raises URLError only from the connect / TLS handshake / request-send leg (a failure after the request
    was sent surfaces from getresponse() / read() as a raw OSError instead); HTTPError is a real answer. A GET /
    DELETE is idempotent anyway; a POST retries only on a connect-class reason (refused, DNS, TLS handshake)."""
    if isinstance(err, urllib.error.HTTPError) or not isinstance(err, urllib.error.URLError):
        return False
    if method in ('GET', 'DELETE'):
        return True
    reason = err.reason
    if isinstance(reason, (ConnectionRefusedError, socket.gaierror)):
        return True
    return 'handshake' in str(reason).lower()


def open_with_retry(req, timeout, method='GET', delays=CONNECT_RETRY_DELAYS_S):
    for i in range(len(delays) + 1):
        try:
            return urllib.request.urlopen(req, timeout=timeout)
        except Exception as e:
            if i >= len(delays) or not connect_failure_retryable(e, method):
                raise
            time.sleep(delays[i])


# ── stream reattach (stream drops, 2026-10-20 — owner "why does connection drop?") ──────────────────────────────────
# A mid-stream reset (the sandbox's own egress proxy restarting cut a live run at 207 s) used to fail the case as a
# stream error although the run kept going server-side. The suite now REATTACHES through GET
# /crossmodel/chats/{chat_id}/stream (signed-in: replays the run's buffer, or the other box's Redis mirror, then
# tails it) and keeps parsing; every reattach is recorded on the turn (`reattaches`) and in the report. At most
# QUERY_SUITE_STREAM_REATTACH_MAX (default 3) per turn; QUERY_SUITE_STREAM_REATTACH_DISABLED=1 restores the old
# behaviour (a reset is a stream error, a clean close without a terminal is silent).
STREAM_REATTACH_MAX_DEFAULT = 3
STREAM_REATTACH_DELAY_S = 2


def stream_reattach_max(env=None):
    env = os.environ if env is None else env
    if str(env.get('QUERY_SUITE_STREAM_REATTACH_DISABLED', '') or '').strip() == '1':
        return 0
    raw = str(env.get('QUERY_SUITE_STREAM_REATTACH_MAX', '') or '').strip()
    try:
        return max(0, int(raw)) if raw else STREAM_REATTACH_MAX_DEFAULT
    except ValueError:
        return STREAM_REATTACH_MAX_DEFAULT


def stream_reset_retryable(err):
    """True for a connection cut MID-STREAM (the request reached the server, a run may be live): a reset / abort /
    remote disconnect / truncated chunked body / TLS EOF. Never an HTTP answer and never a read timeout (a silence
    the case budget already spent). Pure."""
    if isinstance(err, urllib.error.HTTPError) or isinstance(err, (socket.timeout, TimeoutError)):
        return False
    if isinstance(err, urllib.error.URLError):
        return isinstance(err.reason, ConnectionError)
    return isinstance(err, (ConnectionError, http.client.IncompleteRead, ssl.SSLEOFError))


# The fields a reattach replay REBUILDS from the run's buffer (routing / first chunk / engine are not replayed).
REPLAYED_STREAM_FIELDS = ('tools', 'images', 'images_generated', 'chars', 'checks', 'asked', 'prefetched', 'prefetch_unavailable', 'progress_quick', 'canvases')


def snapshot_replayed_fields(rec):
    return {k: (list(rec[k]) if isinstance(rec[k], list) else rec[k]) for k in REPLAYED_STREAM_FIELDS}


def reset_replayed_fields(rec):
    for k in REPLAYED_STREAM_FIELDS:
        v = rec[k]
        rec[k] = [] if isinstance(v, list) else (False if isinstance(v, bool) else 0)


def merge_replayed_fields(rec, snapshot):
    """After a reattach: a full replay is a SUPERSET of what the dropped connection saw, a truncated / empty one a
    subset — keep, per field, whichever is bigger (the pre-drop parse is the floor). Pure."""
    if not snapshot:
        return
    for k, before in snapshot.items():
        now = rec[k]
        if isinstance(before, bool):
            rec[k] = bool(now) or before
        elif isinstance(before, list):
            if len(before) > len(now):
                rec[k] = list(before)
        elif isinstance(before, (int, float)) and before > now:
            rec[k] = before


def consume_stream_events(lines, rec, t0, timeout, on_ask=None, answered=None, conn=None, clock=time.time):
    """Parse ONE SSE connection's lines into `rec` → 'terminal' | 'timeout' | 'eof'. `answered` (question ids) keeps a
    replayed ask-user from being answered twice; `conn` records this connection's shape (frames, a 'truncated' replay
    notice, an interrupted complete, the server's 'queued' ack). Pure but for on_ask."""
    conn = {} if conn is None else conn
    for raw in lines:
        if clock() - t0 > timeout:
            rec['timed_out'] = True
            return 'timeout'
        line = (raw.decode('utf-8', 'replace') if isinstance(raw, (bytes, bytearray)) else str(raw)).strip()
        if not line.startswith('data: '):
            continue
        try:
            ev = json.loads(line[6:])
        except Exception:
            continue
        t, d = ev.get('type'), ev.get('data') or {}
        conn['frames'] = conn.get('frames', 0) + 1
        if t == 'routing' and rec['routing'] is None:
            rec['routing'] = {k: d.get(k) for k in ('level', 'reasonKey', 'source')}
        elif t == 'chunk':
            if rec['first_chunk_s'] is None:
                rec['first_chunk_s'] = round(clock() - t0, 1)
            rec['chars'] += len(str(d.get('content') or ''))
        elif t == 'agent-activity' and d.get('kind') == 'tool':
            rec['tools'].append([str(d.get('label') or ''), str(d.get('name') or '')])
        elif t == 'tool_call':  # the coding harness's frame (capability run)
            rec['engine'] = 'coding'
            rec['tools'].append(['coding', str(d.get('name') or '')])
        elif t == 'text' and d.get('delta'):
            rec['engine'] = 'coding'
            if rec['first_chunk_s'] is None:
                rec['first_chunk_s'] = round(clock() - t0, 1)
            rec['chars'] += len(str(d.get('delta')))
        elif t == 'image':
            rec['images'] += 1
            if d.get('source') == 'generated':
                rec['images_generated'] += 1
        elif t == 'ask-user' and d.get('questionId'):
            # A parked run would hold the case until it expires — answer it the way a hurried user would (the first
            # option, else "your call") and record it. A reattach REPLAYS the question: answer it only once.
            opts = d.get('options') or []
            answer = str(opts[0]) if opts else 'Use your best judgment and go ahead.'
            rec['asked'].append(str(d.get('question') or '')[:120])
            qid = str(d['questionId'])
            if answered is None or qid not in answered:
                if answered is not None:
                    answered.add(qid)
                if on_ask:
                    on_ask(qid, answer)
        elif t == 'progress' and d.get('stage') == 'truncated':
            conn['truncated'] = True  # the reattach replay lost its head (the answer is still saved to the chat)
        elif t == 'progress' and str(d.get('message') or '').startswith('Quick answer'):
            rec['progress_quick'] = True
        elif t == 'progress':
            # 44f0cafc B1: the X injection streams 'Checking X…' BEFORE its fetch legs resolve, and a wholly-degraded
            # x-mcp read (degradedRead returns a TRUTHY failure note) emits no unavailable event at all — so a stage
            # sighting alone cannot prove the read grounded the answer. Track both kinds.
            pev = progress_prefetch_event(t, d)
            if pev:
                kind, stage = pev
                (rec['prefetched'] if kind == 'loaded' else rec['prefetch_unavailable']).append(stage)
        elif t == 'check_state':
            rec['checks'].append(d.get('state'))
        elif t == 'error':
            rec['errors'].append(str(d.get('code') or d.get('message') or 'error')[:160])
        elif t in ('queued', 'question_answered'):
            conn['queued'] = True
        if t == 'complete':
            rec['canvases'] = int(d.get('canvasCount') or 0)
            if d.get('interrupted'):
                conn['interrupted'] = True
        if t in ('complete', 'error'):
            rec['complete_s'] = round(clock() - t0, 1)
            return 'terminal'
    return 'eof'


class Api:
    TOKEN_MAX_AGE_S = 600  # access tokens live 15 min (JWT_EXPIRES_IN) — re-login well before

    def __init__(self, base, email, password):
        self.base = base.rstrip('/')
        self._creds = (email, password)
        self._lock = threading.Lock()
        self.token, self._token_at = None, 0.0
        self._login()

    def _login(self):
        req = urllib.request.Request(self.base + '/auth/login', data=json.dumps({'email': self._creds[0], 'password': self._creds[1]}).encode(), method='POST', headers={'Content-Type': 'application/json'})
        with open_with_retry(req, 30, 'POST') as r:
            self.token = json.loads(r.read())['data']['accessToken']
        self._token_at = time.time()

    def _bearer(self, force=False):
        with self._lock:
            if force or time.time() - self._token_at > self.TOKEN_MAX_AGE_S:
                self._login()
            return 'Bearer ' + self.token

    def _req(self, method, path, body=None, timeout=60, _retry=True):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(self.base + path, data=data, method=method, headers={'Content-Type': 'application/json', 'Authorization': self._bearer(), 'X-Digby-View': 'full'})
        try:
            with open_with_retry(req, timeout, method) as r:
                raw = r.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            if e.code == 401 and _retry:
                self._bearer(force=True)
                return self._req(method, path, body, timeout, _retry=False)
            raise

    def new_chat(self, title):
        d = self._req('POST', '/crossmodel/chats', {'title': title})
        data = d.get('data') or {}
        return data.get('id') or (data.get('chat') or {}).get('id')

    def delete_chat(self, chat_id):
        try:
            self._req('DELETE', f'/crossmodel/chats/{chat_id}')
            return True
        except Exception:
            return False

    def sweep_suite_files(self):
        """Delete the suite's own fixed-name GeneratedFile rows off this account (the
        account-level artifacts a chat delete cannot reach — no FK on the bare chatId
        column). → (#found, #deleted). Read-only on any failure (a broken sweep must
        never break the suite)."""
        found = gone = 0
        try:
            files = self._req('GET', '/crossmodel/generated-files', timeout=30)
        except Exception:
            return 0, 0
        rows = files if isinstance(files, list) else ((files or {}).get('data') or [])
        for row in rows:
            if not suite_file_row(row):
                continue
            found += 1
            try:
                self._req('DELETE', f"/crossmodel/generated-files/{row.get('id')}", timeout=30)
                gone += 1
            except Exception:
                pass
        return found, gone

    def messages(self, chat_id):
        d = self._req('GET', f'/crossmodel/chats/{chat_id}')
        data = d.get('data') or {}
        return data.get('messages') or (data.get('chat') or {}).get('messages') or []

    def sweep_suite_memory(self):
        """Reset the SUITE'S OWN memory facts and topic bans on this account (ticket
        6fd4663a). The suite's forget/remember cases run real remember_fact / forget_fact
        calls, and a chat delete never touches the account-level userMemory blob — so an
        earlier run's "please forget my favourite tea" left a persistent __rejections ban
        that a LATER run's remember turn then had to fight ("do you want to lift that
        ban?" instead of remembering). Only the suite's own fact-key shapes go: the fav
        vocabulary this suite writes (favourite_tea / fav tea / __rejections …) — every
        other fact is the account's own memory and stays.
        → (#facts cleared, #ban lists cleared) — read-only on any failure (a broken
        sweep must never break the suite)."""
        try:
            mem = self._req('GET', '/crossmodel/memory', timeout=30)
        except Exception:
            return 0, 0
        data = mem.get('data') if isinstance(mem, dict) else None
        facts = (data or {}).get('facts') if isinstance(data, dict) else None
        if not isinstance(facts, dict):
            return 0, 0
        drop = {k for k in facts if suite_memory_key(k)}
        if not drop:
            return 0, 0
        cleared = bans = 0
        for k in sorted(drop):
            try:
                self._req('DELETE', f'/crossmodel/memory?key={urllib.parse.quote(str(k))}', timeout=30)
                cleared += 1
                if k == '__rejections':
                    bans += 1
            except Exception:
                pass
        return cleared, bans

    def connected_integrations(self):
        """{name: bool} from GET /crossmodel/<x>/status (a failure reads as not connected)."""
        out = {}
        for name in INTEGRATION_STATUS:
            try:
                out[name] = bool(((self._req('GET', f'/crossmodel/{name}/status', timeout=20) or {}).get('data') or {}).get('connected'))
            except Exception:
                out[name] = False
        return out

    def file_failure_ticket(self, title, description, failing_ids=None):
        """File ONE bug ticket as this account unless an OPEN one with the same title already
        reports every failing case id (44f0cafc: the exact-title gate suppressed a NEW failure
        set while an unrelated nightly ticket stayed open — the 01-tools-x-trends failure was
        lost until a lane filed it by hand). → 'filed' | 'exists' | 'error: …'."""
        try:
            d = self._req('GET', '/crossmodel/feature-requests', timeout=30)
            data = d.get('data') if isinstance(d, dict) else None
            items = data if isinstance(data, list) else ((data or {}).get('requests') or (data or {}).get('items') or [])
            open_rows = [r for r in items if isinstance(r, dict) and r.get('title') == title and str(r.get('status') or 'open') not in ('done', 'resolved', 'closed')]
            if failing_ids is not None:
                # A new failure set files its own row; only a fully-reported set is suppressed.
                # Unparsable/empty failing ids never say covered (fail open toward visibility).
                reported = set()
                for r in open_rows:
                    reported |= ticket_reported_ids(r.get('description'))
                if nightly_ticket_covers(reported, {str(i) for i in failing_ids}):
                    return 'exists'
            elif open_rows:
                return 'exists'
            self._req('POST', '/crossmodel/feature-request', {'type': 'bug_report', 'title': title, 'description': description[:8000]}, timeout=30)
            return 'filed'
        except Exception as e:
            return f'error: {type(e).__name__}: {str(e)[:100]}'

    def answer_question(self, chat_id, question_id, answer):
        try:
            self._req('POST', f'/crossmodel/chats/{chat_id}/questions/{question_id}', {'answer': answer}, timeout=30)
        except Exception:
            pass

    def _attach_request(self, chat_id):
        """GET /crossmodel/chats/{chat_id}/stream — the signed-in reattach (replays the run's buffer, or the other
        box's Redis mirror, then tails it)."""
        return urllib.request.Request(self.base + f'/crossmodel/chats/{urllib.parse.quote(str(chat_id))}/stream', headers={'Authorization': self._bearer(), 'Accept': 'text/event-stream', 'X-Digby-View': 'full'})

    def stream(self, message, chat_id, escalation_of=None, timeout=900, opener=None, reattach_max=None, reattach_delay_s=None):
        params = {'message': message, 'mode': 'auto', 'chatId': chat_id, 'webSearch': 'true'}
        if escalation_of:
            params['escalationOf'] = escalation_of
        req = urllib.request.Request(self.base + '/crossmodel/stream?' + urllib.parse.urlencode(params), headers={'Authorization': self._bearer(), 'Accept': 'text/event-stream', 'X-Digby-View': 'full'})
        rec = {'routing': None, 'tools': [], 'images': 0, 'images_generated': 0, 'errors': [], 'progress_quick': False, 'first_chunk_s': None, 'complete_s': None, 'checks': [], 'timed_out': False, 'chars': 0, 'asked': [], 'engine': 'chat', 'canvases': 0, 'prefetched': [], 'prefetch_unavailable': [], 'reattaches': []}
        t0 = time.time()
        open_fn = opener or open_with_retry
        max_reattach = (stream_reattach_max() if reattach_max is None else reattach_max) if chat_id else 0
        delay_s = STREAM_REATTACH_DELAY_S if reattach_delay_s is None else reattach_delay_s
        answered = set()

        def on_ask(question_id, answer):
            threading.Thread(target=self.answer_question, args=(chat_id, question_id, answer), daemon=True).start()

        def may_reattach():
            return bool(max_reattach) and len(rec['reattaches']) < max_reattach and time.time() - t0 < timeout

        snapshot = None
        while True:
            conn = {'frames': 0, 'truncated': False, 'interrupted': False, 'queued': False}
            cause = None
            try:
                # The stream is a GET: a URLError means the request never fully reached the server (no run started).
                with open_fn(req, timeout, 'GET') as r:
                    outcome = consume_stream_events(r, rec, t0, timeout, on_ask=on_ask, answered=answered, conn=conn)
                # A clean close with no terminal (an nginx / ALB / proxy cut) is a drop too — but never after the
                # server's own 'queued' / 'question_answered' acks, which end the stream on purpose.
                if outcome == 'eof' and not conn['queued'] and may_reattach():
                    cause = 'eof'
            except urllib.error.HTTPError as e:
                rec['errors'].append(f'HTTP {e.code}')
            except Exception as e:  # timeout / connection
                if stream_reset_retryable(e) and may_reattach():
                    cause = type(e).__name__
                else:
                    rec['errors'].append(f'stream: {type(e).__name__}: {str(e)[:120]}')
                    rec['timed_out'] = 'timed out' in str(e).lower()
            if rec['reattaches']:
                # The reattach this connection served: what its replay held.
                rec['reattaches'][-1].update({'frames': conn['frames'], 'truncated': conn['truncated'], 'interrupted': conn['interrupted']})
                merge_replayed_fields(rec, snapshot)
            if cause is None:
                break
            # Reattach: the replay rebuilds the run's events from its start — keep what we parsed so far as the
            # floor (a truncated / empty replay never loses it) and re-parse from empty so nothing double-counts.
            snapshot = snapshot_replayed_fields(rec)
            reset_replayed_fields(rec)
            rec['reattaches'].append({'at_s': round(time.time() - t0, 1), 'cause': cause})
            time.sleep(delay_s)
            req = self._attach_request(chat_id)
        return rec

class Pacer:
    """≤ max_starts stream starts per rolling window (the 25 / 10 min / IP limiter), ≥ min_gap seconds apart."""
    def __init__(self, max_starts=20, window_s=600, min_gap_s=4):
        self.max_starts, self.window_s, self.min_gap_s = max_starts, window_s, min_gap_s
        self.starts = []
        self.lock = threading.Lock()

    def wait(self):
        while True:
            with self.lock:
                now = time.time()
                self.starts = [s for s in self.starts if now - s < self.window_s]
                gap_ok = not self.starts or now - self.starts[-1] >= self.min_gap_s
                if len(self.starts) < self.max_starts and gap_ok:
                    self.starts.append(now)
                    return
                sleep = max(self.min_gap_s - (now - self.starts[-1]) if self.starts else 0, (self.starts[0] + self.window_s - now) if len(self.starts) >= self.max_starts else 0, 1)
            time.sleep(min(sleep, 30))


# ── reading the persisted answer ─────────────────────────────────────────────
# A tool that RAN but FAILED (2026-10-04: 19 Xero calls failed in the owner run and the suite still said PASS — it
# only checked that the tool ran). The persisted answer's `parts` carry each tool_result; these markers on the head
# of a result mean the call did not return data. Checked on the first 300 chars only.
TOOL_ERROR_RE = re.compile(
    r"^(Tool call failed|Error\b|No result from \w+ — the integration may not be connected)"
    r"|could not be called|was rejected by|rate-limited by|failed on \S+ side|could not reach|"
    r"Request failed with status code [45]\d\d|\bHTTP [45]\d\d\b|\bUNAVAILABLE\b|\bnot connected\b"
    r"|No generated file with id \S+ belongs to this user"
    r"|needs? a `fileId`",
    re.I)


# The browser_task / computer_task SUCCESS header (tool-executor.ts formatBrowserTaskToolResult /
# formatComputerTaskToolResult; the same anchor platform/executed-actions.ts parseTaskResult reads) is
# formatter-owned metadata, not the result: it names the absent Mac fallback ("local browser: not
# connected — no Digby Mac agent is paired") on every cloud read, which TOOL_ERROR_RE's `not connected`
# misread as a failed tool (ticket ccd634fb, 2026-10-06 05-tools-browser). It is dropped before the
# match; a failure BANNER ([BROWSER_TASK — INTERACTION UNAVAILABLE …] / [COMPUTER_TASK — UNAVAILABLE])
# rides on its own line ABOVE the header and is still caught.
TASK_RESULT_HEADER_RE = re.compile(r"^!?\[(?:Browser agent result|Computer task result)\s*[—-][^\n]*\]\s*$", re.M)


def tool_errors_of(parts):
    """[[name, head]] for each persisted tool_result whose head reads as a failure. Pure."""
    out = []
    for p in parts if isinstance(parts, list) else []:
        if isinstance(p, dict) and p.get('type') == 'tool_result' and isinstance(p.get('result'), str):
            head = TASK_RESULT_HEADER_RE.sub('', p['result']).strip()[:300]
            if TOOL_ERROR_RE.search(head):
                out.append([str(p.get('name') or ''), head[:160]])
    return out


def answer_facts(msg):
    md = (msg or {}).get('metadata') or {}
    depth = md.get('depth') or {}
    tp = depth.get('turnPlan') or {}
    plan = depth.get('plan') or {}
    task_kind = tp.get('taskKind') if isinstance(tp.get('taskKind'), dict) else {}
    models = {k: (v or {}).get('modelUsed') for k, v in (md.get('models') or {}).items()}
    return {
        'id': (msg or {}).get('id'),
        'content': (msg or {}).get('content') or '',
        'preset': plan.get('preset'),
        'plan_lane': plan.get('lane'),
        # 2026-10-20: the turn's classified task kind (turnPlan.taskKind.kind — the task_kind decision); the model
        # bench files a row under it when the title carries no kind. Additive: nothing in the suite reads it.
        'plan_kind': task_kind.get('kind'),
        'lane': tp.get('lane'),
        'act': bool(tp.get('act')),
        'canary': bool(tp.get('canary')),
        'tp_mode': tp.get('mode'),
        'tp_reason': tp.get('reason'),
        'models': models,
        'check': (md.get('check') or {}).get('state'),
        'kind': md.get('kind'),
        'escalation_rung': md.get('escalationRung'),
        'tool_errors': tool_errors_of((msg or {}).get('parts')),
    }


# ── evaluation (pure — exercised by --self-test) ─────────────────────────────
# ── generic answer checks (every turn; 2026-10-04) ───────────────────────────
# Internal text that must never reach a user (a leaked tool call / reasoning tag / harness marker).
LEAK_RE = re.compile(r"<think>|</think>|\[FOLLOWUPS|<\|tool|<function=|\bDSML\b|\[MACHINE-TRIGGERED|\[HARNESS |\"name\"\s*:\s*\"(?:search_engine|scrape_as_markdown|web_pipe|create_document|generate_image)\"", re.I)
# A refusal of a benign ask (the chat has live web tools — "I can't browse" is false).
REFUSAL_RE = re.compile(r"\b(?:I can(?:no|['’])t|I am unable to|I['’]m unable to|I (?:do not|don['’]t) have (?:the ability|access) to)\b[^.\n]{0,40}\b(?:browse|access the internet|search the web|real-time|look (?:that|this) up|help with that)|\bas an AI(?: language model)?\b", re.I)
# Handing requested work back to the user (the task.lifecycle rule: DONE / RUNNING / STAGED-for-external only).
HANDBACK_RE = re.compile(r"\b(?:say the word|shall I (?:go ahead|proceed|continue)|let me know if you(?:['’]d| would) like me to|would you like me to (?:go ahead|proceed|continue))\b", re.I)
LANG_WORDS = {
    'fr': [' le ', ' la ', ' les ', ' est ', ' et ', ' de ', ' pour ', ' vous ', ' une ', ' que ', ' des '],
    'es': [' el ', ' la ', ' es ', ' y ', ' de ', ' que ', ' los ', ' por ', ' una ', ' del ', ' no '],
    'de': [' der ', ' die ', ' das ', ' ist ', ' und ', ' nicht ', ' ein ', ' mit ', ' zu ', ' den ', ' wird '],
}


def generic_answer_checks(exp, rec, facts):
    """Quality checks that need no per-case expectation → (hard, soft). Pure."""
    hard, soft = [], []
    content = facts.get('content') or ''
    if not content.strip():
        return hard, soft
    m = LEAK_RE.search(content)
    if m:
        hard.append(f"internal text leaked into the answer: {content[max(0, m.start() - 20):m.end() + 30]!r}")
    if not exp.get('ask_ok'):
        r = REFUSAL_RE.search(content)
        if r:
            soft.append(f"refused / disclaimed a benign ask: {r.group(0)[:80]!r}")
    h = HANDBACK_RE.search(content)
    if h:
        soft.append(f"handed work back: {h.group(0)!r}")
    if exp.get('multi_part') and len(content) < 300:
        soft.append(f"a multi-part ask got a {len(content)}-char answer")
    elif exp.get('generic') and not exp.get('ask_ok') and len(content.strip()) < 20:
        soft.append(f"a {len(content.strip())}-char answer")
    lang = exp.get('lang')
    if lang in LANG_WORDS:
        padded = ' ' + re.sub(r'[^\w\s]', ' ', content.lower()) + ' '
        hits = sum(1 for w in LANG_WORDS[lang] if w in padded)
        if hits < 3:
            soft.append(f"asked in '{lang}' but the answer does not read as '{lang}' ({hits} marker words)")
    tool_names = {name for _, name in rec.get('tools', [])}
    if exp.get('web_expected') and not (tool_names & set(WEB_TOOLS)) and not rec.get('prefetched'):
        soft.append('a time-sensitive question was answered without searching')
    if exp.get('code_block') and '```' not in content:
        soft.append('a code ask got no code block')
    return hard, soft


def evaluate_turn(exp, rec, facts, prior_lane=None):
    """→ (verdict, reasons). FAIL on a hard miss, WARN on a soft one."""
    hard, soft = [], []
    if rec.get('errors'):
        hard.append('stream error: ' + '; '.join(rec['errors'])[:160])
    if rec.get('asked') and not exp.get('ask_ok'):
        soft.append(f"the run asked the user (auto-answered): {rec['asked'][0][:80]}")
    if rec.get('timed_out'):
        soft.append('timed out waiting for complete (the run continues server-side)')
    tool_names = {name for _, name in rec.get('tools', [])}
    coding = rec.get('engine') == 'coding'
    if coding:
        soft.append('ran on the CODING harness (a code-intent send attached a workspace) — no turn plan; file tools stand in for document tools')
        tool_names |= {doc for doc, eq in TOOL_EQUIV.items() if tool_names & eq}
    ok_stage = exp.get('prefetch_ok') and exp['prefetch_ok'] in rec.get('prefetched', [])
    # 44f0cafc B1 (adversarial review): the X injection streams its 'Checking X…' progress
    # BEFORE its fetch legs resolve, and a wholly-degraded x-mcp read (degradedRead returns a
    # TRUTHY failure note) emits no unavailable event at all — so a stage sighting alone cannot
    # ground the answer. Withdraw the credit when the unavailable follow-up streamed, or when
    # the answer itself echoes the injected failure vocabulary ("X isn't responding…",
    # "X DATA UNAVAILABLE", "X READ DEGRADED", …).
    degraded_prefetch = bool(
        ok_stage and exp.get('prefetch_ok') == 'x'
        and ('x' in rec.get('prefetch_unavailable', []) or X_PREFETCH_DEGRADED_RE.search(facts.get('content') or ''))
    )
    prefetched = ok_stage and not degraded_prefetch
    artifact_route = exp.get('artifact') and rec.get('canvases', 0) >= exp['artifact']
    if exp.get('tools_any') and not (tool_names & set(exp['tools_any'])) and prefetched:
        soft.append(f"grounded by the controller's {exp['prefetch_ok']} prefetch (no tool call)")
    elif exp.get('tools_any') and not (tool_names & set(exp['tools_any'])) and artifact_route:
        soft.append(f"delivered the artifact as an inline canvas in the answer (no tool call); the dedicated tool ({', '.join(exp['tools_any'][:2])}) preferred")
    elif exp.get('tools_any') and not (tool_names & set(exp['tools_any'])):
        why = '; the controller X prefetch streamed but delivered no usable data (unavailable/degraded)' if degraded_prefetch else ''
        hard.append(f"none of the expected tools ran ({', '.join(exp['tools_any'][:4])}…); ran: {', '.join(sorted(tool_names)) or 'none'}{why}")
    # 1f67492f B1 (adversarial review): the refresh credit must be EVIDENCED, not
    # presence-based — an ERRORED update_document, an update of an unrelated file with no
    # account-files sighting, or a coding-harness edit_file on scratch (TOOL_EQUIV credit)
    # must not soften a genuine create regression. Gate on (a) the refresh not being in
    # tool_errors, and (b) a same-run sighting of the account's generated files
    # (list_files / read_document) — the run actually FOUND the leftover before refreshing.
    errs = facts.get('tool_errors') or []
    errored = {n for n, _ in errs}
    sighted = bool(tool_names & {'list_files', 'read_document'})
    for group in exp.get('tools_all', []):
        if tool_names & set(group):
            continue
        # 1f67492f: a same-named file already on the account (a suite leftover a missed sweep
        # left behind — the 2026-10-07 01:19Z run's rate.md) makes the honest move a REFRESH:
        # update_document's own contract ("use when the user asks to change, extend, or correct
        # a file you created earlier"). The create step then WARNs (create preferred — the
        # pre-run sweep is the real fix), never a nightly FAIL. FENCED to document-create
        # steps only, and only for a NON-ERRORED refresh that followed an account-files
        # sighting: anything else still fails hard.
        if 'create_document' in group and 'update_document' in tool_names and 'update_document' not in errored and sighted:
            soft.append(f"the create step refreshed the account's existing same-name file (update_document, after {'/'.join(sorted(tool_names & {'list_files', 'read_document'}))}) instead of creating a new one; create ({', '.join(group[:3])}) preferred — the suite sweeps its fixed-name files before a run (1f67492f)")
            continue
        hard.append(f"a required step did not run (none of {', '.join(group[:4])}); ran: {', '.join(sorted(tool_names)) or 'none'}")
    expected_ran = tool_names & set(exp.get('tools_any') or [])
    if expected_ran and expected_ran <= errored:
        first = next(h for n, h in errs if n in expected_ran)
        hard.append(f"the expected tool ran but FAILED ({', '.join(sorted(expected_ran))}): {first[:110]}")
    elif errs:
        soft.append(f"tool error(s): {'; '.join(f'{n}: {h[:60]}' for n, h in errs[:2])}")
    if exp.get('tools_prefer') and tool_names & set(exp.get('tools_any') or []) and not (tool_names & set(exp['tools_prefer'])):
        soft.append(f"answered without the dedicated tool ({', '.join(exp['tools_prefer'])}); ran: {', '.join(sorted(tool_names))}")
    if exp.get('artifact') and rec.get('canvases', 0) + len(tool_names & {'create_document', 'create_canvas'}) < exp['artifact']:
        hard.append('expected an artifact in Files (a canvas or a generated file); the run produced neither')
    if exp.get('read_only'):
        wrote = sorted(tool_names & WRITE_TOOLS)
        if wrote:
            hard.append(f"a READ-ONLY integration case called a write tool: {', '.join(wrote)}")
    if exp.get('images_generated') and 'generate_image' in tool_names and rec.get('images_generated', 0) < exp['images_generated']:
        hard.append('generate_image ran but no generated image streamed to the chat')
    if not facts.get('id'):
        hard.append('no answer row persisted for this turn')
        return 'FAIL', hard + soft
    for pat in exp.get('answer_regex', []):
        if not re.search(pat, facts.get('content') or ''):
            hard.append(f'answer does not match /{pat}/')
    lanes = None if coding else exp.get('lanes')
    if lanes and facts.get('lane') and facts['lane'] not in lanes:
        soft.append(f"turn-plan lane {facts['lane']} not in {lanes}")
    if lanes and not facts.get('lane'):
        soft.append('no turn plan recorded on the answer')
    if exp.get('no_quick_act') and facts.get('act'):
        hard.append('the Quick lane ACTED on a turn that must not take it')
    if exp.get('no_quick_act_if_prior_deep') and prior_lane in ('checked', 'research') and facts.get('act'):
        hard.append(f'the Quick lane acted on a follow-up in a {prior_lane} session (hysteresis)')
    if exp.get('quick_act') and facts.get('lane') == 'quick' and not facts.get('act'):
        soft.append(f"quick lane not acted ({facts.get('tp_reason') or 'no reason'})")
    if facts.get('act') and facts.get('plan_lane') != 'quick':
        hard.append('turn plan says act but the answer did not run the Quick lane')
    g_hard, g_soft = generic_answer_checks(exp, rec, facts)
    hard += g_hard
    soft += g_soft
    if facts.get('plan_lane') == 'quick' and not rec.get('progress_quick'):
        soft.append('Quick lane ran without its "Quick answer — looking it up…" progress line')
    verdict = 'FAIL' if hard else ('WARN' if soft else 'PASS')
    return verdict, hard + soft


def find_answer(msgs, user_text=None, after_id=None, kind=None):
    """The answer row for one turn: the first assistant row after the LAST user row carrying
    `user_text` (or after the assistant row `after_id`; with `kind`, the first such row of that
    kind). Counting rows would misattribute a turn when a background continuation, a Deeper
    findings row or a hand-off posts an extra assistant row in between. Pure."""
    start = None
    for k, m in enumerate(msgs):
        if user_text is not None and m.get('role') == 'user' and (m.get('content') or '').strip() == user_text.strip():
            start = k
        if after_id is not None and m.get('id') == after_id:
            start = k
    if start is None:
        return None
    for m in msgs[start + 1:]:
        if m.get('role') != 'assistant':
            continue
        md = m.get('metadata') or {}
        if kind is not None:
            if md.get('kind') == kind:
                return m
            continue
        if md.get('kind') in SIDE_KINDS or md.get('verifier') or md.get('origin') in SIDE_ORIGINS:
            continue  # a side row (an addendum about an EARLIER turn, a hand-off, a verifier note) is never this turn's answer
        return m
    return None


# Rows that are NOT a turn's answer (2026-10-04: the late Double Checker's "Update to an earlier answer" row —
# kind check_addendum — landed after the NEXT user message and was misread as that turn's answer and as a double
# answer; council_addendum is its L3 twin; both mirror live-chat-audit.ts SIDE_KINDS).
SIDE_KINDS = {'deeper_findings', 'continuation_result', 'deliverable_handoff', 'control_note', 'check_addendum', 'council_addendum'}
SIDE_ORIGINS = {'machine', 'agent', 'deliverable_handoff'}  # rows another seat / the harness posted, never a re-answer


def transcript_audit(msgs):
    """Whole-chat checks after a case → (hard, soft). Pure.
    - a user row answered by MORE THAN ONE ordinary assistant row = the same question run twice
      (found by this suite 2026-10-04: a client disconnect mid-run left two full answers);
    - an action-verifier correction row on a human chat (soft — it can be right, but on a plain
      chat it is user-visible and was a false positive on an honest "my browser task timed out")."""
    hard, soft = [], []
    current, answers = None, 0
    def close():
        if current is not None and answers > 1:
            hard.append(f"the question was answered {answers} times: {current[:60]!r}")
    for m in msgs:
        md = m.get('metadata') or {}
        if m.get('role') == 'user':
            close()
            current, answers = (m.get('content') or ''), 0
        elif m.get('role') == 'assistant':
            if md.get('verifier') or md.get('origin') in SIDE_ORIGINS:
                if md.get('verifier'):
                    soft.append(f"{md.get('verifier')} correction posted: {(m.get('content') or '')[:110]!r}")
                continue
            if md.get('kind') in SIDE_KINDS:
                continue
            answers += 1
    close()
    return hard, soft


def wait_answer(api, chat_id, tries=8, delay=3, **where):
    """find_answer once the row persists (the finalize lands just after `complete`), else None."""
    for k in range(tries):
        try:
            hit = find_answer(api.messages(chat_id), **where)
        except Exception:
            hit = None
        if hit:
            return hit
        time.sleep(delay if k else 2)
    return None


def run_case(api, pacer, case, timeout, settle=300):
    title = f"e2e suite {case['id']} {time.strftime('%H:%M')}"
    chat_id = api.new_chat(title)
    out = {'id': case['id'], 'category': case['category'], 'name': case['name'], 'chat_id': chat_id, 'turns': []}
    prior_lane = None
    last_answer_id = None
    fresh = set(case.get('fresh_chat_turns') or [])
    main_chat = chat_id
    for i, msg in enumerate(case['turns']):
        exp = case['expect'][i] if i < len(case['expect']) else {}
        chat_id = api.new_chat(f"{title} t{i + 1}") if i in fresh else main_chat
        if i in fresh:
            out.setdefault('extra_chat_ids', []).append(chat_id)
        pacer.wait()
        rec = api.stream(msg, chat_id, timeout=timeout)
        # After a client-side timeout the run continues server-side — give it time to persist.
        tries = max(8, settle // 5) if rec.get('timed_out') or rec.get('errors') else 8
        facts = answer_facts(wait_answer(api, chat_id, tries=tries, delay=5, user_text=msg))
        verdict, reasons = evaluate_turn(exp, rec, facts, prior_lane)
        out['turns'].append({'message': msg, 'verdict': verdict, 'reasons': reasons, 'routing': rec['routing'], 'lane': facts['lane'], 'act': facts['act'], 'canary': facts['canary'], 'plan_lane': facts['plan_lane'], 'preset': facts['preset'], 'models': facts['models'], 'tools': rec['tools'], 'images': rec['images'], 'images_generated': rec['images_generated'], 'asked': rec['asked'], 'engine': rec['engine'], 'first_chunk_s': rec['first_chunk_s'], 'complete_s': rec['complete_s'], 'check': facts['check'], 'tp_reason': facts['tp_reason'], 'answer_chars': len(facts['content']), 'answer_head': facts['content'][:400], 'prefetched': rec['prefetched'], 'prefetch_unavailable': rec['prefetch_unavailable'], 'tool_errors': facts['tool_errors'], 'canvases': rec['canvases'], 'reattaches': rec.get('reattaches', [])})
        if i not in fresh:
            prior_lane = facts['lane'] or prior_lane
            last_answer_id = facts['id']
    chat_id = main_chat
    if case.get('dig') and last_answer_id:
        pacer.wait()
        rec = api.stream('Dig deeper', chat_id, escalation_of=last_answer_id, timeout=timeout)
        facts = answer_facts(wait_answer(api, chat_id, after_id=last_answer_id, kind='deeper_findings'))
        hard = []
        if rec['errors']:
            hard.append('dig deeper error: ' + '; '.join(rec['errors'])[:160])
        want = (case.get('expect_dig') or {}).get('rung_preset')
        if want and facts.get('preset') != want:
            hard.append(f"dig deeper ran preset {facts.get('preset')}, expected {want}")
        if facts.get('kind') != 'deeper_findings':
            hard.append(f"no 'Deeper findings' row (kind {facts.get('kind')})")
        out['turns'].append({'message': '[Dig deeper]', 'verdict': 'FAIL' if hard else 'PASS', 'reasons': hard, 'routing': rec['routing'], 'preset': facts['preset'], 'models': facts['models'], 'tools': rec['tools'], 'first_chunk_s': rec['first_chunk_s'], 'complete_s': rec['complete_s'], 'check': facts['check'], 'answer_chars': len(facts['content']), 'reattaches': rec.get('reattaches', [])})
    audit_hard, audit_soft = [], []
    for cid in [main_chat, *(out.get('extra_chat_ids') or [])]:
        try:
            h, so = transcript_audit(api.messages(cid))
        except Exception as e:
            h, so = [], [f'transcript audit unavailable: {type(e).__name__}']
        audit_hard += h
        audit_soft += so
    if audit_hard or audit_soft:
        out['turns'].append({'message': '[transcript audit]', 'verdict': 'FAIL' if audit_hard else 'WARN', 'reasons': audit_hard + audit_soft, 'tools': []})
    out['verdict'] = 'FAIL' if any(t['verdict'] == 'FAIL' for t in out['turns']) else ('WARN' if any(t['verdict'] == 'WARN' for t in out['turns']) else 'PASS')
    return out


# audit 2026-10-08 W4-7 — the LATENCY GATE. The suite reported first-chunk times but never judged them: the 10-08
# night's checked lane had a first-chunk p50 of 389.7 s and 01-checked-contested PASSed with a 591 s first chunk.
# The gate reads the run's first-chunk distribution over the ordinary turns (Dig-deeper / transcript rows and research
# councils excluded) and names every bar it breaks; with --file-ticket-on-fail a breach files ONE
# '[nightly query suite] first-word latency over the bar' bug (deduped while an open one exists). It never changes the
# exit code (a slow night is a ticket, not a red build). Bars (seconds, env-overridable): QUERY_SUITE_LATENCY_P50_S
# (120), QUERY_SUITE_LATENCY_P90_S (300), QUERY_SUITE_LATENCY_QUICK_P50_S (45, the Quick lane), min turns
# QUERY_SUITE_LATENCY_MIN_N (5). Kill switch QUERY_SUITE_LATENCY_GATE_DISABLED=1.
LATENCY_TICKET_TITLE = '[nightly query suite] first-word latency over the bar'
LATENCY_GATE_DEFAULTS = {'p50': 120.0, 'p90': 300.0, 'quick_p50': 45.0, 'min_n': 5}


def latency_bars(env=None):
    env = os.environ if env is None else env
    out = dict(LATENCY_GATE_DEFAULTS)
    for key, name in (('p50', 'QUERY_SUITE_LATENCY_P50_S'), ('p90', 'QUERY_SUITE_LATENCY_P90_S'), ('quick_p50', 'QUERY_SUITE_LATENCY_QUICK_P50_S'), ('min_n', 'QUERY_SUITE_LATENCY_MIN_N')):
        raw = str(env.get(name, '') or '').strip()
        try:
            v = float(raw)
            if v > 0:
                out[key] = v
        except ValueError:
            pass
    return out


def _pct(xs, q):
    xs = sorted(x for x in xs if isinstance(x, (int, float)))
    return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))] if xs else None


def latency_gate(turns, env=None):
    """The run's first-chunk gate -> {'n', 'p50', 'p90', 'quick_n', 'quick_p50', 'bars', 'breaches': [str]}. Pure."""
    env = os.environ if env is None else env
    bars = latency_bars(env)
    ordinary = [t for t in turns if not str(t.get('message', '')).startswith('[') and t.get('lane') != 'research' and t.get('preset') not in ('deep_research', 'deep_research_all')]
    firsts = [t.get('first_chunk_s') for t in ordinary if isinstance(t.get('first_chunk_s'), (int, float))]
    quick = [t.get('first_chunk_s') for t in ordinary if t.get('plan_lane') == 'quick' and isinstance(t.get('first_chunk_s'), (int, float))]
    out = {'n': len(firsts), 'p50': _pct(firsts, 0.5), 'p90': _pct(firsts, 0.9), 'quick_n': len(quick), 'quick_p50': _pct(quick, 0.5), 'bars': bars, 'breaches': []}
    if str(env.get('QUERY_SUITE_LATENCY_GATE_DISABLED', '') or '').strip() == '1':
        out['disabled'] = True
        return out
    if out['n'] >= bars['min_n']:
        if out['p50'] is not None and out['p50'] > bars['p50']:
            out['breaches'].append(f"first-chunk p50 {out['p50']} s > {bars['p50']:g} s over {out['n']} turns")
        if out['p90'] is not None and out['p90'] > bars['p90']:
            out['breaches'].append(f"first-chunk p90 {out['p90']} s > {bars['p90']:g} s over {out['n']} turns")
    if out['quick_n'] >= 3 and out['quick_p50'] is not None and out['quick_p50'] > bars['quick_p50']:
        out['breaches'].append(f"Quick-lane first-chunk p50 {out['quick_p50']} s > {bars['quick_p50']:g} s over {out['quick_n']} turns")
    return out


def latency_ticket_body(summary, run_url=''):
    """The latency ticket's description — synthetic questions only, no user data. Pure."""
    g = summary.get('latency_gate') or {}
    lines = [f"The nightly live query suite (scripts/e2e/query-suite.py, profile {summary.get('profile', 'test')}, seed {summary.get('seed')}) broke its first-word latency bar." + (f" Run: {run_url}" if run_url else ''), '', 'Breaches:']
    lines += [f'- {b}' for b in g.get('breaches', [])]
    lines += ['', 'Latency by lane (first chunk p50 s / done p50 s):']
    lines += [f"- {k}: n {v['n']} · {v['first_chunk_p50']} / {v['complete_p50']}" for k, v in (summary.get('latency_by_lane') or {}).items()]
    lines += ['', 'Read: the lead seat / model pick per lane (turn_plan modelPick), web calls before the first word, the lane budget, provider latency. Bars: QUERY_SUITE_LATENCY_* (docs/E2E_QUERY_SUITE.md).']
    return '\n'.join(lines)


def stream_reattach_summary(results):
    """Every mid-stream reattach of the run (stream drops, 2026-10-20) → [{'case', 'turn', 'cause', 'at_s', 'frames',
    'truncated', 'interrupted'}]. Pure."""
    out = []
    for r in results:
        for i, t in enumerate(r.get('turns', [])):
            for a in t.get('reattaches') or []:
                out.append({'case': r.get('id'), 'turn': i + 1 if not str(t.get('message', '')).startswith('[') else t.get('message'), **{k: a.get(k) for k in ('cause', 'at_s', 'frames', 'truncated', 'interrupted')}})
    return out


def summarize(results):
    turns = [t for r in results for t in r['turns'] if not t['message'].startswith('[')]
    def p(xs, q):
        xs = sorted(x for x in xs if isinstance(x, (int, float)))
        return xs[min(len(xs) - 1, int(q * (len(xs) - 1) + 0.5))] if xs else None
    by_lane = {}
    for t in turns:
        key = 'quick-ran' if t.get('plan_lane') == 'quick' else f"lane:{t.get('lane') or 'none'}"
        by_lane.setdefault(key, []).append(t)
    tool_counts = {}
    for t in turns:
        for _, name in t.get('tools', []):
            tool_counts[name] = tool_counts.get(name, 0) + 1
    seen = {name for t in turns for _, name in t.get('tools', [])}
    covered = {fam: sorted(set(tools) & seen) for fam, tools in TOOL_FAMILIES.items()}
    return {
        'tool_families_covered': sorted(f for f, hit in covered.items() if hit),
        'tool_families_not_exercised': sorted(f for f, hit in covered.items() if not hit),
        'cases': len(results),
        'verdicts': {v: sum(1 for r in results if r['verdict'] == v) for v in ('PASS', 'WARN', 'FAIL')},
        'turns': len(turns),
        'quick_acted': sum(1 for t in turns if t.get('act')),
        'latency_by_lane': {k: {'n': len(v), 'first_chunk_p50': p([t['first_chunk_s'] for t in v], 0.5), 'complete_p50': p([t['complete_s'] for t in v], 0.5)} for k, v in sorted(by_lane.items())},
        'tool_calls': dict(sorted(tool_counts.items(), key=lambda kv: -kv[1])),
        'failures': [f"{r['id']}: {'; '.join(x for t in r['turns'] for x in t['reasons'] if t['verdict'] == 'FAIL')}" for r in results if r['verdict'] == 'FAIL'],
        'latency_gate': latency_gate(turns),
        'stream_reattaches': stream_reattach_summary(results),
    }


def markdown_report(results, summary):
    lines = [f"# Digby query suite — seed {summary.get('seed')} · {time.strftime('%Y-%m-%d %H:%MZ', time.gmtime())}", '',
             f"**{summary['verdicts']['PASS']} pass · {summary['verdicts']['WARN']} warn · {summary['verdicts']['FAIL']} fail** over {summary['cases']} cases / {summary['turns']} turns; Quick lane acted on {summary['quick_acted']}.", '',
             '| case | turn | verdict | route | lane | act | first chunk s | done s | tools | notes |', '|---|---|---|---|---|---|---|---|---|---|']
    for r in results:
        for i, t in enumerate(r['turns']):
            msg = t['message'].replace('|', '/')[:70]
            tools = ', '.join(sorted({n for _, n in t.get('tools', [])}))
            notes = '; '.join(t.get('reasons', [])).replace('|', '/')[:160]
            lines.append(f"| {r['id'] if i == 0 else ''} | {msg} | {t['verdict']} | {(t.get('routing') or {}).get('level') or '-'} | {t.get('lane') or '-'} | {'yes' if t.get('act') else ''} | {t.get('first_chunk_s') or '-'} | {t.get('complete_s') or '-'} | {tools} | {notes} |")
    lines += ['', '## Latency by lane', '', '| lane | n | first chunk p50 s | done p50 s |', '|---|---|---|---|']
    for k, v in summary['latency_by_lane'].items():
        lines.append(f"| {k} | {v['n']} | {v['first_chunk_p50']} | {v['complete_p50']} |")
    g = summary.get('latency_gate') or {}
    if g:
        lines += ['', '## Latency gate', '', (f"**BREACHED** — {'; '.join(g['breaches'])}" if g.get('breaches') else ('off (QUERY_SUITE_LATENCY_GATE_DISABLED)' if g.get('disabled') else f"within the bars (first chunk p50 {g.get('p50')} s / p90 {g.get('p90')} s over {g.get('n')} turns)"))]
    re_rows = summary.get('stream_reattaches') or []
    lines += ['', '## Stream reattaches', '']
    if re_rows:
        lines += [f"{len(re_rows)} mid-stream reattach(es) through /chats/{{id}}/stream — the run kept going server-side.", '',
                  '| case | turn | cause | at s | replay frames | truncated | run had ended |', '|---|---|---|---|---|---|---|']
        lines += [f"| {a['case']} | {a['turn']} | {a['cause']} | {a['at_s']} | {a.get('frames', '-')} | {'yes' if a.get('truncated') else ''} | {'yes' if a.get('interrupted') else ''} |" for a in re_rows]
    else:
        lines.append('none')
    lines += ['', '## Tool calls', '', ', '.join(f'{k} ×{v}' for k, v in summary['tool_calls'].items()) or 'none']
    lines += ['', '## Tool-family coverage', '', f"Covered: {', '.join(summary.get('tool_families_covered', [])) or 'none'}", '',
              f"Not exercised this run: {', '.join(summary.get('tool_families_not_exercised', [])) or 'none'}", '',
              'Excluded by design: ' + '; '.join(f'{k} ({v})' for k, v in EXCLUDED_BY_DESIGN.items())]
    return '\n'.join(lines) + '\n'


def print_table(results):
    print(f"{'case':38} {'verdict':7} {'route':16} {'lane':9} {'act':4} {'ttft':>6} {'done':>6}  tools")
    for r in results:
        for i, t in enumerate(r['turns']):
            name = r['id'] if i == 0 else '  └ ' + (t['message'][:30] if t['message'].startswith('[') else f'turn {i + 1}')
            route = (t.get('routing') or {}).get('level') or '-'
            tools = ','.join(sorted({n for _, n in t.get('tools', [])}))[:60]
            print(f"{name[:38]:38} {t['verdict']:7} {route[:16]:16} {str(t.get('lane') or '-')[:9]:9} {'Y' if t.get('act') else '-':4} {str(t.get('first_chunk_s') or '-'):>6} {str(t.get('complete_s') or '-'):>6}  {tools}")
            for reason in t.get('reasons', [])[:3]:
                print(f"{'':48}↳ {reason[:110]}")
            if t.get('reattaches'):
                print(f"{'':48}↳ stream reattached ×{len(t['reattaches'])} ({', '.join(str(a.get('cause')) for a in t['reattaches'])})")


# ── self-test (no network) ───────────────────────────────────────────────────
def self_test():
    ok = True
    def check(cond, label):
        nonlocal ok
        print(('  ok: ' if cond else '  FAIL: ') + label)
        ok = ok and cond
    rec = {'errors': [], 'tools': [['Digby', 'search_engine']], 'images': 0, 'images_generated': 0, 'progress_quick': True, 'timed_out': False, 'asked': []}
    v, _ = evaluate_turn({'lanes': ['quick'], 'tools_any': WEB_TOOLS, 'quick_act': True}, rec, {'id': 'a', 'lane': 'quick', 'act': True, 'plan_lane': 'quick', 'content': 'sunny'})
    check(v == 'PASS', 'a quick weather turn that searched and acted passes')
    v, rs = evaluate_turn({'tools_any': ['generate_image']}, {**rec, 'tools': []}, {'id': 'a', 'lane': 'standard', 'content': ''})
    check(v == 'FAIL' and 'none of the expected tools' in rs[0], 'a missing required tool fails')
    v, _ = evaluate_turn({'no_quick_act': True}, rec, {'id': 'a', 'lane': 'quick', 'act': True, 'plan_lane': 'quick', 'content': 'x'})
    check(v == 'FAIL', 'a Quick act on a must-not turn fails')
    v, _ = evaluate_turn({'no_quick_act_if_prior_deep': True}, rec, {'id': 'a', 'lane': 'quick', 'act': True, 'plan_lane': 'quick', 'content': 'x'}, prior_lane='research')
    check(v == 'FAIL', 'a Quick act on a follow-up in a research session fails (hysteresis)')
    v, rs = evaluate_turn({'lanes': ['quick']}, rec, {'id': 'a', 'lane': 'standard', 'act': False, 'content': 'x'})
    check(v == 'WARN' and 'lane standard' in rs[0], 'an unexpected lane is a WARN, not a FAIL')
    v, _ = evaluate_turn({'answer_regex': ['teal']}, rec, {'id': 'a', 'lane': 'standard', 'content': 'Your favourite colour is teal.'})
    check(v == 'PASS', 'a recalled memory passes')
    v, _ = evaluate_turn({}, {**rec, 'errors': ['RATE_LIMIT']}, {'id': 'a', 'content': ''})
    check(v == 'FAIL', 'a stream error fails')
    v, rs = evaluate_turn({}, rec, {'id': 'a', 'lane': 'quick', 'act': True, 'plan_lane': None, 'content': 'x'})
    check(v == 'FAIL' and 'did not run the Quick lane' in rs[0], 'act without the Quick lane running fails')
    v, rs = evaluate_turn({}, {**rec, 'progress_quick': False}, {'id': 'a', 'lane': 'quick', 'act': True, 'plan_lane': 'quick', 'content': 'x'})
    check(v == 'WARN' and 'progress line' in rs[0], 'a Quick run without its progress line is a WARN')
    v, rs = evaluate_turn({'tools_any': ['create_document'], 'lanes': ['standard']}, {**rec, 'engine': 'coding', 'tools': [['coding', 'write_file']]}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and 'CODING harness' in rs[0] and len(rs) == 1, 'a coding-harness run: write_file stands in for create_document, lanes skipped, one WARN')
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]}, rec, {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'FAIL' and 'required step' in rs[0], 'a chain missing its second tool fails')
    v, _ = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]}, {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'create_document']]}, {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'PASS', 'a chain with both tools passes')
    # 1f67492f: the 2026-10-07 nightly's false FAIL — the account held rate.md from the
    # 2026-10-07 01:19Z run (GeneratedFile, no chat FK — cleanup never reached it), the run
    # correctly refreshed it (update_document after sighting it), and the hard create step starved.
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]},
                          {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'list_files'], ['Digby', 'read_document'], ['Digby', 'update_document']]},
                          {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'WARN' and 'refreshed' in rs[0], 'a chain whose create step refreshed the account\'s existing same-name file WARNs, not FAILs (1f67492f)')
    # ... and the same shape on the CODING harness (edit_file stands in for update_document):
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]},
                          {**rec, 'engine': 'coding', 'tools': [['coding', 'search_engine'], ['coding', 'list_files'], ['coding', 'edit_file']]},
                          {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and any('refreshed' in r for r in rs), 'the coding-harness refresh twin WARNs too (edit_file → update_document)')
    # B1 fence (adversarial review): the refresh credit is EVIDENCED, not presence-based —
    # an ERRORED update_document, or one with NO account-files sighting in the run, still FAILs.
    ud_fail = {'id': 'a', 'content': 'x', 'tool_errors': [['update_document', 'No generated file with id abc123 belongs to this user. Call list_files to see the current files.']]}
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]},
                          {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'list_files'], ['Digby', 'update_document']]}, ud_fail)
    check(v == 'FAIL' and 'required step' in rs[0], 'an ERRORED update_document (tool_errors hit) never takes the refresh route (B1 fence)')
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]},
                          {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'update_document']]},
                          {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'FAIL' and 'required step' in rs[0], 'an update_document with no account-files sighting (list_files/read_document) in the run never takes the refresh route (B1 fence)')
    # The fence: only a document-CREATE step refreshes; any other missing chain step still fails.
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_canvas']]},
                          {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'list_files'], ['Digby', 'update_document']]},
                          {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'FAIL' and 'required step' in rs[0], 'a non-create chain step never takes the refresh route (the 1f67492f fence)')
    v, rs = evaluate_turn({'tools_all': [WEB_TOOLS, ['create_document']]},
                          {**rec, 'tools': [['Digby', 'search_engine']]},
                          {'id': 'a', 'lane': 'standard', 'content': 'x'})
    check(v == 'FAIL' and 'required step' in rs[0], 'a create step with neither create nor refresh still fails hard')
    check(all(suite_file_row({'filename': n}) for n in SUITE_FILENAMES), 'every suite fixed name is swept')
    check(not suite_file_row({'filename': 'quarterly-report.xlsx'}) and not suite_file_row({'filename': 'rate'}) and not suite_file_row({}), 'a non-suite name (or no name) is never swept')
    named = {f for cat in PROFILES['test']['categories'] for fn in CATALOG[cat] for k in range(12) for t in fn(random.Random(k))['turns'] for f in re.findall(r'[\w.-]+\.(?:md|txt|xlsx|csv|docx|pdf)\b', t)}
    check(not (named - SUITE_FILENAMES), f'every filename a test-profile prompt names is in the sweep set (missing: {sorted(named - SUITE_FILENAMES)})')
    # D1 (self-audit): the extension regex above cannot see fixed TITLES ("titled 'Packing list'")
    # — the name-based sweep missed exactly that row. Pin the title route directly (lowercased,
    # the same normalization suite_file_row applies).
    titled = {(m + '.md').lower() for m in re.findall(r"titled '([^']+)'", ' '.join(t for cat in PROFILES['test']['categories'] for fn in CATALOG[cat] for k in range(12) for t in fn(random.Random(k))['turns']))}
    check(not (titled - SUITE_FILENAMES), f'every TITLE a test-profile prompt names maps into the sweep set (missing: {sorted(titled - SUITE_FILENAMES)})')
    # The sweep itself, against a faked HTTP layer: only suite rows are deleted, in
    # both list shapes the endpoint can answer (bare list / {data: [...]}), and a
    # failing DELETE still counts the rest.
    class _FakeApi(Api):
        def __init__(self, rows):
            self.rows, self.calls, self.fail_ids = rows, [], set()
        def _req(self, method, path, body=None, timeout=60, _retry=True):
            self.calls.append((method, path))
            if method == 'GET':
                return self.rows
            if path.rsplit('/', 1)[-1] in self.fail_ids:
                raise urllib.error.HTTPError(path, 500, 'boom', {}, None)
            return {'ok': True}
    fake = _FakeApi([{'id': 'f1', 'filename': 'rate.md'}, {'id': 'f2', 'filename': 'Packing List.MD'},
                     {'id': 'f3', 'filename': 'ideas.md'}, {'id': 'f4', 'filename': 'image-x.png'}])
    found, gone = fake.sweep_suite_files()
    check((found, gone) == (3, 3) and [p for m, p in fake.calls if m == 'DELETE'] == ['/crossmodel/generated-files/f1', '/crossmodel/generated-files/f2', '/crossmodel/generated-files/f3'],
          'the sweep deletes exactly the suite fixed-name rows (incl. the fixed TITLE Packing list.md, D1)')
    fake = _FakeApi({'data': [{'id': 'f1', 'filename': 'notes.txt'}]})
    found, gone = fake.sweep_suite_files()
    check((found, gone) == (1, 1), 'the sweep reads the {data:[…]} list shape too')
    fake = _FakeApi([{'id': 'f1', 'filename': 'rate.md'}, {'id': 'f2', 'filename': 'week.xlsx'}])
    fake.fail_ids = {'f1'}
    found, gone = fake.sweep_suite_files()
    check((found, gone) == (2, 1), 'a failing DELETE counts the row but keeps sweeping')
    # 6fd4663a — the memory sweep: only the suite's own fact-key shapes go, in every
    # separator shape the extractor writes, and the owner's real facts survive.
    check(suite_memory_key('favourite tea'), "the observed ban key 'favourite tea' is swept")
    check(all(suite_memory_key(k) for k in ('favourite_tea', 'FAVOURITE Tea', 'fav tea', 'favorite-tea', 'favourite board game', '__rejections', '__dream')),
          'every suite fact-key shape (underscore / spaced / dashed / __ bookkeeping) is swept')
    check(not any(suite_memory_key(k) for k in ('favourite restaurant', 'tea', 'oolong', 'name', 'city', 'Project velocity', 'rejections')), 'an owner fact or a non-suite key is never swept (all __ bookkeeping IS swept)')

    class _FakeMemApi(Api):
        def __init__(self, facts, fail_keys=frozenset()):
            self.facts, self.calls, self.fail_keys = facts, [], set(fail_keys)
        def _req(self, method, path, body=None, timeout=60, _retry=True):
            self.calls.append((method, path))
            if method == 'GET':
                return {'data': {'facts': self.facts}}
            if any(f'key={urllib.parse.quote(k)}' in path for k in self.fail_keys):
                raise urllib.error.HTTPError(path, 500, 'boom', {}, None)
            return {'ok': True}
    fake = _FakeMemApi({'favourite tea': 'oolong', '__rejections': ['favourite tea'], 'timezone': 'America/Vancouver'})
    cleared, bans = fake.sweep_suite_memory()
    check((cleared, bans) == (2, 1) and [p for m, p in fake.calls if m == 'DELETE'] == ['/crossmodel/memory?key=__rejections', '/crossmodel/memory?key=favourite%20tea'],
          'the memory sweep deletes exactly the suite keys (fav phrase + ban list, sorted), sparing the owner fact')
    fake = _FakeMemApi({'name': 'Paul', 'timezone': 'America/Vancouver'})
    cleared, bans = fake.sweep_suite_memory()
    check((cleared, bans) == (0, 0) and fake.calls == [('GET', '/crossmodel/memory')], 'no suite keys → GET only, zero writes')
    fake = _FakeMemApi({'favourite_tea': 'oolong', 'favourite colour': 'teal', '__rejections': ['favourite_tea']})
    fake.fail_keys = {'favourite_tea'}
    cleared, bans = fake.sweep_suite_memory()
    check((cleared, bans) == (2, 1), 'a failing DELETE counts only what actually cleared, keeps sweeping')
    v, rs = evaluate_turn({'tools_any': ['browser_task', 'scrape_as_markdown'], 'tools_prefer': ['browser_task']}, {**rec, 'tools': [['Digby', 'scrape_as_markdown']]}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and 'dedicated tool' in rs[0], 'a fallback tool instead of the preferred one is a WARN')
    v, _ = evaluate_turn({'tools_any': ['generate_image'], 'images_generated': 1}, {**rec, 'tools': [['Digby', 'generate_image']]}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL', 'generate_image with no generated image streamed fails')
    v, rs = evaluate_turn({}, {**rec, 'asked': ['which city?']}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and 'asked the user' in rs[0], 'an ask_user on a plain request is a WARN')
    a = sample_cases(30, 7, list(CATALOG), 1)
    b = sample_cases(30, 7, list(CATALOG), 1)
    check([c['turns'] for c in a] == [c['turns'] for c in b], 'sampling is deterministic for a seed')
    check(sum(1 for c in a if c['category'] == 'research') <= 1, '--max-research caps research cases')
    check(len({tuple(c['turns']) for c in a}) == len(a), 'no duplicate cases in a sample')
    check(all(c['category'] != 'research' for c in a[:-1]) or a[-1]['category'] == 'research', 'research runs last')
    unsafe = re.compile(r'send (a )?message|share link|autonomy|coding session|delete my|email (it|this) to|post (it|this)|subscribe', re.I)
    names = [c['name'] for c in sample_cases(12, 3, ['tools'], 1)]
    check(len(set(names)) == len(names), 'a category sample uses distinct templates before repeating one')
    check(not any(unsafe.search(t) for fn_list in CATALOG.values() for fn in fn_list for k in range(6) for t in fn(random.Random(k))['turns']), 'no template asks for an external-effect tool')
    sched = [t for fn in CATALOG['platform'] for k in range(6) for t in fn(random.Random(k))['turns'] if 'remind me' in t]
    check(sched and all('in this chat' in t for t in sched), 'a reminder case targets THIS chat only (and the next turn cancels it)')
    check(profile_refusal('owner', ['memory']) and profile_refusal('owner', ['tools']) and not profile_refusal('owner', ['integrations']), 'the owner profile runs integrations only')
    check(not profile_refusal('test', ['tools', 'files', 'platform']) and profile_refusal('test', ['integrations']), 'the test profile never runs integrations')
    check(PROFILES['owner'].get('force_cleanup') is True, 'the owner profile always deletes its chats')
    write_verbs = re.compile(r'\b(send|post|create|draft|delete|remove|schedule|book|reply|invite|share|upload|write|append|update)\b', re.I)
    integ = [fn(random.Random(k)) for fn in CATALOG['integrations'] for k in range(6)]
    check(all(not write_verbs.search(c['turns'][0]) for c in integ), 'no integration prompt asks for a write')
    check(all(c['expect'][0].get('read_only') for c in integ), 'every integration case FAILS on any write tool')
    check(not any(t in WRITE_TOOLS for c in integ for t in c['expect'][0].get('tools_any', [])), 'no integration case expects a write tool')
    v, rs = evaluate_turn({'tools_any': ['gmail_search'], 'read_only': True}, {**rec, 'tools': [['Digby', 'gmail_search'], ['Digby', 'gmail_send_email']]}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL' and any('READ-ONLY' in r for r in rs), 'a write tool on a read-only case fails')
    # 43c24152 DETECTOR-RECALL REPLAY — this suite's write-tool detector
    # (WRITE_TOOLS ∩ read_only ⇒ FAIL) lost its retired feed members
    # (create_feed / delete_feed were write tools; list_feeds was an acceptable
    # platform read) because the topic-feed tools no longer exist on the
    # platform. Replaying the detector's PRIOR true positives and asserting
    # they STILL fire, plus the intended delta (no case can demand or credit a
    # retired feed tool — demanding one would manufacture a guaranteed FAIL):
    v, rs = evaluate_turn({'tools_any': ['gmail_search'], 'read_only': True}, {**rec, 'tools': [['Digby', 'gmail_search'], ['Digby', 'gmail_send_email']]}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL' and any('READ-ONLY' in r for r in rs), 'DETECTOR-RECALL REPLAY: the pinned gmail_send_email write still convicts a read-only case')
    for wt in sorted(WRITE_TOOLS):
        v, rs = evaluate_turn({'tools_any': ['gmail_search'], 'read_only': True}, {**rec, 'tools': [['Digby', 'gmail_search'], ['Digby', wt]]}, {'id': 'a', 'content': 'x'})
        check(v == 'FAIL' and any('READ-ONLY' in r for r in rs), f'DETECTOR-RECALL REPLAY: every remaining write tool ({wt}) still convicts a read-only case')
    for retired in ('create_feed', 'delete_feed', 'list_feeds', 'set_feed', 'refresh_feed'):
        check(retired not in WRITE_TOOLS, f'DETECTOR-RECALL REPLAY: the retired {retired} is out of the write-detector set')
    rendered_cases = [fn(random.Random(k)) for fns in CATALOG.values() for fn in fns for k in range(6)]
    expected_tools = {t for c in rendered_cases for e in c.get('expect', []) for t in e.get('tools_any', [])}
    for retired in ('create_feed', 'delete_feed', 'list_feeds', 'set_feed', 'refresh_feed'):
        check(retired not in expected_tools, f'DETECTOR-RECALL REPLAY: no catalog case can expect the retired {retired}')
    plat_prompts = [fn(random.Random(k))['turns'][0] for k in range(12) for fn in [tpl_platform_reads]]
    check(all('feed' not in p.lower() for p in plat_prompts), 'DETECTOR-RECALL REPLAY: the platform-read prompt never asks about feeds')
    check('xero' in SKIP_INTEGRATIONS, 'Xero is never tested (owner 2026-10-04: not in use)')
    only_google = sample_cases(10, 4, ['integrations'], 1, connected={'google'})
    check(bool(only_google) and all(c.get('requires') in (None, 'google') for c in only_google), 'unconnected integrations are never sampled')
    v, rs = evaluate_turn({'generic': True}, rec, {'id': 'a', 'content': 'Sure! <think>plan the search</think> Here it is.'})
    check(v == 'FAIL' and 'leaked' in rs[0], 'a leaked <think> tag fails')
    v, rs = evaluate_turn({'generic': True}, rec, {'id': 'a', 'content': "I'm sorry, but I can't browse the internet to check that for you right now."})
    check(v == 'WARN' and any('refused' in r for r in rs), "a false 'I can't browse' is a WARN")
    v, rs = evaluate_turn({'generic': True}, rec, {'id': 'a', 'content': 'I found three options. Say the word and I will book the first one for you.'})
    check(v == 'WARN' and any('handed work back' in r for r in rs), 'a hand-back is a WARN')
    v, rs = evaluate_turn({'generic': True, 'multi_part': True}, rec, {'id': 'a', 'content': 'Day 1: museums. Day 2: food.'})
    check(v == 'WARN' and any('multi-part' in r for r in rs), 'a short answer to a multi-part ask is a WARN')
    v, rs = evaluate_turn({'generic': True, 'lang': 'fr'}, rec, {'id': 'a', 'content': 'You could write: sorry for the delay, I am running late.'})
    check(v == 'WARN' and any("asked in 'fr'" in r for r in rs), 'an English answer to a French ask is a WARN')
    v, _ = evaluate_turn({'generic': True, 'lang': 'fr'}, rec, {'id': 'a', 'content': "Vous pouvez écrire : « Je vous prie de m'excuser pour le retard, je serai là dans dix minutes. » C'est poli et clair pour un email."})
    check(v == 'PASS', 'a French answer to a French ask passes')
    v, rs = evaluate_turn({'generic': True, 'web_expected': True}, {**rec, 'tools': []}, {'id': 'a', 'content': 'It will probably rain tomorrow in Toronto, around 12 degrees.'})
    check(v == 'WARN' and any('without searching' in r for r in rs), 'a time-sensitive answer with no search is a WARN')
    v, rs = evaluate_turn({'generic': True, 'code_block': True}, rec, {'id': 'a', 'content': 'Use SELECT customer, SUM(total) FROM orders GROUP BY customer ORDER BY 2 DESC LIMIT 5.'})
    check(v == 'WARN' and any('code block' in r for r in rs), 'a code ask with no code block is a WARN')
    hc_rng = random.Random(3)
    cases = [human_corpus.human_case(hc_rng) for _ in range(200)] + [human_corpus.thread_case(hc_rng) for _ in range(30)]
    check(all(c['turns'] and len(c['turns']) == len(c['expect']) for c in cases), 'every human case has one expectation per turn')
    check(not any('{' + k + '}' in t for c in cases for t in c['turns'] for k in human_corpus.SLOTS), 'every human slot is filled')
    check(len({c['name'] for c in cases}) >= 15, 'the human corpus spans many topic groups')
    check(not any(unsafe.search(t) for c in cases for t in c['turns']), 'no human message asks for an external-effect tool')
    xero_fail = {'id': 'a', 'content': 'x', 'tool_errors': [['xero_get_organisation', 'Xero Organisation was rejected by Xero (HTTP 401) — the Xero connection needs re-authorizing']]}
    v, rs = evaluate_turn({'tools_any': ['xero_get_organisation']}, {**rec, 'tools': [['Digby', 'xero_get_organisation']]}, xero_fail)
    check(v == 'FAIL' and 'ran but FAILED' in rs[0], 'an expected tool that ran but failed is a FAIL (the 2026-10-04 Xero gap)')
    v, rs = evaluate_turn({'tools_any': ['search_engine']}, {**rec, 'tools': [['Digby', 'search_engine'], ['Digby', 'scrape_as_markdown']]}, {'id': 'a', 'content': 'x', 'tool_errors': [['scrape_as_markdown', 'Tool call failed: timeout']]})
    check(v == 'WARN' and 'tool error' in rs[0], 'an error on a non-expected tool is a WARN')
    check(tool_errors_of([{'type': 'tool_result', 'name': 'gmail_search', 'result': 'Found 3 emails: ...'}, {'type': 'tool_result', 'name': 'xero_get_invoices', 'result': 'No result from Xero — the integration may not be connected (Settings → Integrations) or nothing matched.'}]) == [['xero_get_invoices', 'No result from Xero — the integration may not be connected (Settings → Integrations) or nothing matched.']], 'tool_errors_of reads failures from persisted parts only')
    ok_read = ('[Browser agent result — driver: cloud, steps: 2 · local browser: not connected — no Digby Mac agent is paired'
               ' · why: public page · mode: read-only cloud browser (reading pages was enough)]\nThe heading is "Example Domain".')
    check(tool_errors_of([{'type': 'tool_result', 'name': 'browser_task', 'result': ok_read}]) == [],
          "a browser_task header naming the absent Mac ('local browser: not connected') is metadata, never a failure (ccd634fb)")
    banner = ('[BROWSER_TASK — INTERACTION UNAVAILABLE (hard capability limit)]\nINTERACTION UNAVAILABLE — this browser session ran READ-ONLY.\n'
              '[Browser agent result — driver: cloud, steps: 2 · local browser: not connected]\nI read the page but the form needs a login.')
    check([n for n, _ in tool_errors_of([{'type': 'tool_result', 'name': 'browser_task', 'result': banner}])] == ['browser_task'],
          'the INTERACTION UNAVAILABLE banner above the header is still a failed browser_task')
    check([n for n, _ in tool_errors_of([{'type': 'tool_result', 'name': 'computer_task', 'result': '[COMPUTER_TASK — UNAVAILABLE]\nNo usable Mac is paired.\n[Computer task result — steps: 0 · mac: not connected]\n'}])] == ['computer_task'],
          'a computer_task UNAVAILABLE banner is still a failure')
    v, rs = evaluate_turn({'tools_any': ['plaid_get_accounts'], 'prefetch_ok': 'plaid', 'read_only': True}, {**rec, 'tools': [], 'prefetched': ['plaid']}, {'id': 'a', 'content': 'Chase checking'})
    check(v == 'WARN' and 'prefetch' in rs[0], 'an integration answer grounded by the controller prefetch is a WARN, not a FAIL')
    v, _ = evaluate_turn({'tools_any': ['plaid_get_accounts'], 'prefetch_ok': 'plaid'}, {**rec, 'tools': [], 'prefetched': ['google']}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL', "another family's prefetch never grounds the case")
    # 44f0cafc — the tools-category X twin takes the same prefetch grounding as the
    # integrations twins: the controller's X prefetch (integration-context.ts) injected the
    # posts the 2026-10-07 nightly's zero-tool answer was built from (prefetched ['x']).
    xrec = {**rec, 'tools': [], 'prefetched': ['x']}
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], xrec, {'id': 'a', 'content': 'Keegan Matheson: #BlueJays season ended.'})
    check(v == 'WARN' and 'x prefetch' in rs[0], 'an X answer grounded by the controller prefetch is a WARN, not a FAIL (44f0cafc)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [], 'prefetched': []}, {'id': 'a', 'content': 'The Blue Jays are trending.'})
    check(v == 'FAIL' and 'none of the expected tools' in rs[0], 'an X answer with no tool and no prefetch still fails (44f0cafc)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [['Digby', 'search_engine']]}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and 'dedicated tool' in rs[0], 'an X answer via search_engine alone is a WARN (the dedicated X tool is preferred — unchanged fence, 44f0cafc)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [['Digby', 'x_search']]}, {'id': 'a', 'content': 'x'})
    check(v == 'PASS', 'an X answer via the dedicated x_search tool still passes (44f0cafc)')
    # 44f0cafc B1 (adversarial review) — the degraded-prefetch fence. The X injection streams
    # 'Checking X…' BEFORE its legs resolve; a wholly-degraded read either streams the
    # xUnavailable follow-up or injects a failure note the answer echoes. Either way the
    # stage sighting must NOT ground a zero-tool answer.
    check(progress_prefetch_event('progress', {'stage': 'x', 'message': 'Checking X…'}) == ('loaded', 'x'), "the X stage's 'Checking…' progress is a prefetch sighting (44f0cafc B1)")
    check(progress_prefetch_event('progress', {'stage': 'x', 'message': "X isn't responding right now — carrying on without it."}) == ('unavailable', 'x'), 'the xUnavailable follow-up retracts the X stage credit (44f0cafc B1)')
    check(progress_prefetch_event('progress', {'stage': 'google', 'message': 'Checking your Google Workspace…'}) == ('loaded', 'google'), "a google 'Checking…' progress is a prefetch sighting (44f0cafc B1)")
    check(progress_prefetch_event('progress', {'stage': 'quick', 'message': 'Loading…'}) is None and progress_prefetch_event('chunk', {}) is None, 'unknown stages and non-progress events are not prefetch sightings (44f0cafc B1)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [], 'prefetched': ['x'], 'prefetch_unavailable': ['x']}, {'id': 'a', 'content': 'I could not reach X right now.'})
    check(v == 'FAIL' and 'prefetch streamed but delivered no usable data' in rs[0], 'a zero-tool answer over an X prefetch that went unavailable FAILs, with the reason naming it (44f0cafc B1)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [], 'prefetched': ['x']}, {'id': 'a', 'content': 'Sorry — X data could not be fetched for this reply.'})
    check(v == 'FAIL' and 'delivered no usable data' in rs[0], 'a zero-tool answer echoing the injected X-unavailable vocabulary FAILs even without the event (44f0cafc B1)')
    v, rs = evaluate_turn(tpl_x_public(random.Random(0))['expect'][0], {**rec, 'tools': [], 'prefetched': ['x']}, {'id': 'a', 'content': "without a connected X account, the live read came through Google's index of x.com rather than X's own search, so I can tell you the content of the posts but not exact timestamps. Keegan Matheson: #BlueJays — the season just ended."})
    check(v == 'WARN' and 'x prefetch' in rs[0], 'the 2026-10-07 answer shape (SERP provenance caveat, no failure vocabulary) still WARNs as grounded (44f0cafc B1)')
    v, rs = evaluate_turn({'artifact': 1}, {**rec, 'canvases': 0}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL' and 'artifact in Files' in rs[0], 'an artifact case with neither a canvas nor a generated file fails')
    v, _ = evaluate_turn({'artifact': 1}, {**rec, 'canvases': 1}, {'id': 'a', 'content': 'x'})
    check(v == 'PASS', 'a canvas counts as the Files artifact')
    v, _ = evaluate_turn({'artifact': 1}, {**rec, 'tools': [['Digby', 'create_document']]}, {'id': 'a', 'content': 'x'})
    check(v == 'PASS', 'a generated file counts as the Files artifact')
    # 92857a41: a "document" ask may land as a canvas (the playbook's own route) — never a FAIL, and it
    # satisfies the artifact expectation exactly like an inline [CANVAS] block or a generated file.
    v, rs = evaluate_turn({'tools_any': ['create_document', 'create_canvas'], 'tools_prefer': ['create_document'], 'artifact': 1},
                          {**rec, 'tools': [['Digby', 'create_canvas'], ['Double Checker', 'search_memory']]}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and any('dedicated tool' in r for r in rs) and not any('expected tools' in r for r in rs),
          "a canvas for a document ask passes with a WARN (create_document preferred) — the run 37539254348 05 shape (92857a41)")
    # ... and the third route, run 37556487363 (01:30Z): the answer delivered the artifact as an INLINE
    # [CANVAS] block (the create_canvas tool description itself says to prefer the answer's own canvas
    # markers when writing an answer) — canvasCount 1, zero tool calls. The artifact is the outcome.
    v, rs = evaluate_turn({'tools_any': ['create_document', 'create_canvas'], 'tools_prefer': ['create_document'], 'artifact': 1},
                          {**rec, 'tools': [], 'canvases': 1}, {'id': 'a', 'content': 'x'})
    check(v == 'WARN' and any('inline canvas' in r for r in rs) and not any('expected tools' in r for r in rs),
          "an inline-canvas answer for a document ask is a WARN (the artifact landed), never a FAIL — the run 37556487363 shape (92857a41)")
    v, rs = evaluate_turn({'tools_any': ['create_document', 'create_canvas'], 'tools_prefer': ['create_document'], 'artifact': 1},
                          {**rec, 'tools': [['Digby', 'create_document']]}, {'id': 'a', 'content': 'x'})
    check(v == 'PASS', 'create_document for a document ask stays a clean PASS (the dedicated tool)')
    v, rs = evaluate_turn({'tools_any': ['create_document', 'create_canvas'], 'artifact': 1}, {**rec, 'tools': []}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL', 'a document ask that made no artifact still FAILs')
    # 1da06d4e — the fence on the artifact_route softening (landed in #1319): it fires ONLY for cases
    # that carry an artifact expectation. The format-named asks (tpl_tool_sheet "budget.xlsx",
    # tpl_tool_doc_format docx/pdf/csv) have no artifact key — for them a canvas deliverable is a real
    # miss, not a route choice — so a zero-tool run stays a hard FAIL. (No such pin existed on main.)
    v, rs = evaluate_turn({'tools_any': ['create_document']}, {**rec, 'tools': []}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL' and 'none of the expected tools' in rs[0],
          'a document ask with NO artifact key and no tool call still fails hard — the fence (1da06d4e)')
    v, rs = evaluate_turn({'tools_any': ['create_document']}, {**rec, 'tools': [], 'canvases': 1}, {'id': 'a', 'content': 'x'})
    check(v == 'FAIL' and 'none of the expected tools' in rs[0],
          'a canvas does NOT rescue a no-artifact-key ask — an .xlsx/.docx/.pdf/.csv deliverable as a canvas is a real miss (1da06d4e)')
    # 92857a41: integration state rides every signed-in turn's [YOUR INTEGRATION STATUS] context block, so a
    # grounded no-tool answer is the integrations-twin verdict (PASS on content), with the tool preferred only.
    v, rs = evaluate_turn({'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']},
                          {**rec, 'tools': []}, {'id': 'a', 'content': 'Everything is disconnected right now: Google ❌, GitHub ❌ not connected.'})
    check(v == 'PASS' and not rs, "an account-overview answer grounded in the context block passes with no tool call — the run 37539254348 13 shape (92857a41)")
    v, rs = evaluate_turn({'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']},
                          {**rec, 'tools': [['Digby', 'list_memory']]}, {'id': 'a', 'content': 'Google is connected.'})
    check(v == 'PASS', 'another (read-only) tool grounding the answer stays a clean PASS too — no wrong-family penalty without tools_any')
    v, rs = evaluate_turn({'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']},
                          {**rec, 'tools': [['Digby', 'remember_fact']]}, {'id': 'a', 'content': 'Google is connected.'})
    check(v == 'FAIL' and any('READ-ONLY' in r for r in rs), 'a write tool on the account-overview case still FAILs (read_only)')
    v, rs = evaluate_turn({'tools_prefer': ['get_account_overview'], 'read_only': True, 'answer_regex': [r'(?i)connected']},
                          {**rec, 'tools': []}, {'id': 'a', 'content': 'I cannot check that.'})
    check(v == 'FAIL' and any('answer does not match' in r for r in rs), 'a non-answer to the account-overview ask still FAILs (answer_regex)')
    p = Pacer(max_starts=2, window_s=1, min_gap_s=0)
    t0 = time.time(); p.wait(); p.wait(); p.wait()
    check(time.time() - t0 >= 0.9, 'the pacer holds the third start past the window')
    msgs = [{'id': 'u1', 'role': 'user', 'content': 'hi'}, {'id': 'a1', 'role': 'assistant', 'content': 'hello'},
            {'id': 'a1b', 'role': 'assistant', 'content': 'late continuation', 'metadata': {'kind': 'continuation_result'}},
            {'id': 'u2', 'role': 'user', 'content': 'weather?'}, {'id': 'a2', 'role': 'assistant', 'content': 'sunny'},
            {'id': 'a3', 'role': 'assistant', 'content': 'deeper', 'metadata': {'kind': 'deeper_findings'}}]
    check((find_answer(msgs, user_text='weather?') or {}).get('id') == 'a2', 'the answer row follows its own user row, not a row count')
    late = [{'id': 'u1', 'role': 'user', 'content': 'q1'}, {'id': 'a1', 'role': 'assistant', 'content': 'answer 1', 'metadata': {}},
            {'id': 'u2', 'role': 'user', 'content': 'q2'},
            {'id': 'x1', 'role': 'assistant', 'content': '**Update to an earlier answer** …', 'metadata': {'kind': 'check_addendum', 'addendumFor': 'a1'}},
            {'id': 'a2', 'role': 'assistant', 'content': 'answer 2', 'metadata': {}}]
    check((find_answer(late, user_text='q2') or {}).get('id') == 'a2', 'a late check addendum about an earlier turn is never the next turn\'s answer')
    h, _ = transcript_audit(late)
    check(not h, 'a late check addendum is never counted as a second answer')
    hs = urllib.error.URLError('_ssl.c:983: The handshake operation timed out')
    check(connect_failure_retryable(hs, 'POST'), 'a TLS handshake timeout is retried even for a POST (nothing reached the server)')
    check(connect_failure_retryable(urllib.error.URLError(ConnectionRefusedError()), 'POST'), 'a refused connect is retried for a POST')
    check(not connect_failure_retryable(urllib.error.URLError('Connection reset by peer'), 'POST'), 'a POST that may have been sent is never retried')
    check(connect_failure_retryable(urllib.error.URLError('timed out'), 'GET'), 'a GET retries any send-leg failure')
    check(not connect_failure_retryable(urllib.error.HTTPError('u', 500, 'x', {}, None), 'GET'), 'an HTTP status is an answer, never retried')
    check(not connect_failure_retryable(TimeoutError('read'), 'GET'), 'a read timeout after the request was sent is never retried')
    check(find_answer(msgs, user_text='not sent') is None, 'an unsent turn finds no answer')
    check((find_answer(msgs, after_id='a2', kind='deeper_findings') or {}).get('id') == 'a3', 'the Deeper findings row is found after the tapped answer')
    dup = [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a', 'metadata': {}}, {'role': 'assistant', 'content': 'b', 'metadata': {'origin': 'user'}}]
    h, so = transcript_audit(dup)
    check(len(h) == 1 and 'answered 2 times' in h[0], 'a question answered twice fails the transcript audit')
    ok_rows = [{'role': 'user', 'content': 'q'}, {'role': 'assistant', 'content': 'a', 'metadata': {}},
               {'role': 'assistant', 'content': 'deeper', 'metadata': {'kind': 'deeper_findings'}},
               {'role': 'assistant', 'content': '⚠️ [ACTION VERIFIER', 'metadata': {'origin': 'machine', 'verifier': 'action-verifier'}}]
    ok_rows += [{'role': 'assistant', 'content': 'Permission request … ALLOWED', 'metadata': {'kind': 'control_note', 'origin': 'agent'}},
                {'role': 'assistant', 'content': 'Result: …', 'metadata': {'kind': 'deliverable_handoff', 'origin': 'deliverable_handoff'}}]
    h, so = transcript_audit(ok_rows)
    check(not h and len(so) == 1 and 'action-verifier' in so[0], 'side rows never count as a second answer; a verifier correction is a WARN')
    v, rs = evaluate_turn({'answer_regex': ['x']}, rec, {'id': None, 'content': ''})
    check(v == 'FAIL' and rs == ['no answer row persisted for this turn'], 'a missing answer is one clear FAIL, not a cascade')
    body = failure_ticket_body({'profile': 'test', 'seed': 9, 'cases': 3, 'verdicts': {'FAIL': 1}, 'failures': ['02-tools-x: none of the expected tools ran']}, 'https://run')
    check('seed 9' in body and '02-tools-x' in body and 'Run: https://run' in body, 'the nightly failure ticket names the seed, the failures and the run')
    # 44f0cafc — the filing gate must dedupe on the failure SET, not the title: the nightly
    # printed "failure ticket: exists" while an unrelated nightly ticket was open and the new
    # 01-tools-x-trends failure was never filed. A new failing case id always files; an
    # already-reported set is suppressed; an unparsable/empty state never counts as covered.
    summ = {'profile': 'test', 'seed': 20261007, 'cases': 14, 'verdicts': {'FAIL': 1},
            'failures': ['01-tools-x-trends: none of the expected tools ran (x_get_trends, x_search, search_engine, web_pipe…); ran: none']}
    check(nightly_failing_ids(summ) == ['01-tools-x-trends'], 'nightly_failing_ids reads the failing case ids off a summary (44f0cafc)')
    covered_desc = failure_ticket_body({'profile': 'test', 'seed': 1, 'cases': 3, 'verdicts': {'FAIL': 1}, 'failures': ['01-tools-x-trends: none of the expected tools ran']}, 'https://old-run')
    check(ticket_reported_ids(covered_desc) == {'01-tools-x-trends'}, 'ticket_reported_ids reads the reported case ids back off a ticket body (44f0cafc)')
    check(nightly_ticket_covers(ticket_reported_ids(covered_desc), ['01-tools-x-trends']) is True, 'an open ticket reporting every failing id suppresses filing (44f0cafc)')
    check(nightly_ticket_covers(set(), ['01-tools-x-trends']) is False, 'an open ticket with a different failure set files the new failure (44f0cafc)')
    check(nightly_ticket_covers({'01-tools-x-trends'}, []) is False and nightly_ticket_covers({'01-tools-x-trends'}, None) is False, 'an empty failing set never claims to be covered (44f0cafc)')
    check(nightly_ticket_covers(ticket_reported_ids('no failure lines here'), ['01-tools-x-trends']) is False, 'an unparsable open description never suppresses a new failure (44f0cafc)')
    check(ticket_reported_ids('x') == set() and ticket_reported_ids(None) == set(), 'ticket_reported_ids tolerates junk descriptions (44f0cafc)')
    fake = [{'id': '01-quick-weather', 'verdict': 'PASS', 'turns': [{'message': 'weather?', 'verdict': 'PASS', 'reasons': [], 'routing': {'level': 'single_thinking'}, 'lane': 'quick', 'act': True, 'plan_lane': 'quick', 'tools': [['Digby', 'search_engine']], 'first_chunk_s': 6.1, 'complete_s': 9.0}]}]
    summ = {**summarize(fake), 'seed': 1}
    md = markdown_report(fake, summ)
    check(summ['quick_acted'] == 1 and summ['tool_calls'] == {'search_engine': 1}, 'the summary counts acts and tool calls')
    check('| 01-quick-weather | weather? | PASS |' in md and 'quick-ran' in md, 'the markdown report renders a row and the lane latency table')
    # audit 2026-10-08 W4-7: the latency gate
    slow = [{'message': f'q{i}', 'lane': 'checked', 'plan_lane': 'checked', 'first_chunk_s': x} for i, x in enumerate([150, 389.7, 200, 591, 120])]
    g = latency_gate(slow, env={})
    check(g['n'] == 5 and any('p50 200' in b for b in g['breaches']) and any('p90 591' in b for b in g['breaches']), 'the latency gate names the p50 and p90 breaches of a 10-08-shaped night (389.7 s checked p50, a 591 s first chunk)')
    check(latency_gate(slow[:4], env={})['breaches'] == [], 'the latency gate needs QUERY_SUITE_LATENCY_MIN_N turns')
    check(latency_gate(slow, env={'QUERY_SUITE_LATENCY_GATE_DISABLED': '1'})['breaches'] == [], 'QUERY_SUITE_LATENCY_GATE_DISABLED=1 turns the gate off')
    check(latency_gate(slow, env={'QUERY_SUITE_LATENCY_P50_S': '600', 'QUERY_SUITE_LATENCY_P90_S': '900'})['breaches'] == [], 'the bars are env-overridable')
    fast = [{'message': f'q{i}', 'lane': 'quick', 'plan_lane': 'quick', 'first_chunk_s': x} for i, x in enumerate([60, 70, 80])]
    check(any('Quick-lane' in b for b in latency_gate(fast, env={})['breaches']), 'a slow Quick lane breaches its own bar')
    check(latency_gate([{'message': '[Dig deeper]', 'first_chunk_s': 999}] * 6 + [{'message': 'x', 'lane': 'research', 'first_chunk_s': 999}] * 6, env={})['n'] == 0, 'Dig-deeper / research turns never count')
    check('first-word latency' in LATENCY_TICKET_TITLE and 'Breaches:' in latency_ticket_body({**summ, 'latency_gate': g}), 'the latency ticket body lists the breaches')
    check('## Latency gate' in markdown_report(fake, summ), 'the markdown report renders the latency gate')
    # stream drops (2026-10-20): a mid-stream reset reattaches through /chats/{id}/stream and keeps parsing
    class _Conn:
        def __init__(self, frames, then=None):
            self.frames, self.then = frames, then
        def __enter__(self):
            return self
        def __exit__(self, *a):
            return False
        def __iter__(self):
            for f in self.frames:
                yield (f'data: {json.dumps(f)}\n').encode()
            if self.then is not None:
                raise self.then
    def _opener(conns, seen):
        def open_(req, timeout, method):
            seen.append(req.full_url)
            return conns.pop(0)
        return open_
    fake = Api.__new__(Api)
    fake.base, fake._bearer = 'https://digby.test/api', (lambda force=False: 'Bearer t')
    answered_q = []
    fake.answer_question = lambda chat_id, qid, ans: answered_q.append(qid)
    run = [{'type': 'routing', 'data': {'level': 'thinking'}}, {'type': 'agent-activity', 'data': {'kind': 'tool', 'label': 'Digby', 'name': 'web_search'}},
           {'type': 'ask-user', 'data': {'questionId': 'q1', 'question': 'which?', 'options': ['A']}}, {'type': 'chunk', 'data': {'content': 'Hello '}}]
    replay = run[1:] + [{'type': 'chunk', 'data': {'content': 'world'}}, {'type': 'complete', 'data': {}}]
    seen = []
    rec = fake.stream('q', 'chat-1', opener=_opener([_Conn(run, ConnectionResetError('reset by peer')), _Conn(replay)], seen), reattach_max=3, reattach_delay_s=0)
    time.sleep(0.05)  # the ask-user answer rides a daemon thread
    check(rec['errors'] == [] and rec['complete_s'] is not None and len(rec['reattaches']) == 1 and rec['reattaches'][0]['cause'] == 'ConnectionResetError', 'a mid-stream reset reattaches once and the turn completes without a stream error')
    check(seen[1].endswith('/crossmodel/chats/chat-1/stream'), 'the reattach goes through the signed-in /chats/{id}/stream attach')
    check(rec['chars'] == len('Hello world') and rec['tools'] == [['Digby', 'web_search']], 'the replay is re-parsed from empty — chars and tools are never double-counted')
    check(answered_q == ['q1'], 'a replayed ask-user is answered once')
    check((rec['routing'] or {}).get('level') == 'thinking', 'pre-run frames (routing) survive the reattach')
    seen = []
    rec = fake.stream('q', 'chat-1', opener=_opener([_Conn(run, ConnectionResetError('x')), _Conn([{'type': 'complete', 'data': {'interrupted': True}}])], seen), reattach_max=3, reattach_delay_s=0)
    check(rec['reattaches'][0].get('interrupted') is True and rec['chars'] == len('Hello ') and rec['tools'] == [['Digby', 'web_search']], 'a reattach that finds the run already ended keeps what was parsed before the drop (the floor)')
    rec = fake.stream('q', 'chat-1', opener=_opener([_Conn(run, ConnectionResetError('x'))], []), reattach_max=0, reattach_delay_s=0)
    check(rec['reattaches'] == [] and rec['errors'] and rec['errors'][0].startswith('stream: ConnectionResetError'), 'QUERY_SUITE_STREAM_REATTACH_DISABLED (max 0): a reset is a stream error, as before')
    rec = fake.stream('q', 'chat-1', opener=_opener([_Conn(run, ConnectionResetError('x')), _Conn(run, ConnectionResetError('y'))], []), reattach_max=1, reattach_delay_s=0)
    check(len(rec['reattaches']) == 1 and rec['errors'] and 'ConnectionResetError' in rec['errors'][0], 'the reattach budget is bounded; the last reset is reported')
    rec = fake.stream('q', 'chat-1', opener=_opener([_Conn([{'type': 'queued', 'data': {'position': 1}}])], []), reattach_max=3, reattach_delay_s=0)
    check(rec['reattaches'] == [] and rec['errors'] == [], "a deliberate close after the server's 'queued' ack is not a drop")
    check(stream_reset_retryable(ConnectionResetError()) and stream_reset_retryable(http.client.IncompleteRead(b'')) and not stream_reset_retryable(socket.timeout('t')) and not stream_reset_retryable(urllib.error.HTTPError('u', 502, 'x', {}, None)), 'only connection cuts are reattach-retryable (never a timeout or an HTTP answer)')
    check(stream_reattach_max({}) == STREAM_REATTACH_MAX_DEFAULT and stream_reattach_max({'QUERY_SUITE_STREAM_REATTACH_DISABLED': '1'}) == 0 and stream_reattach_max({'QUERY_SUITE_STREAM_REATTACH_MAX': '5'}) == 5, 'the reattach budget is env-overridable and kill-switchable')
    fake_res = [{'id': '01-x', 'verdict': 'PASS', 'turns': [{'message': 'hi', 'verdict': 'PASS', 'reasons': [], 'tools': [], 'first_chunk_s': 1.0, 'complete_s': 2.0, 'reattaches': [{'cause': 'eof', 'at_s': 207.0, 'frames': 40, 'truncated': False, 'interrupted': False}]}]}]
    s2 = {**summarize(fake_res), 'seed': 1}
    check(s2['stream_reattaches'][0]['case'] == '01-x' and '## Stream reattaches' in markdown_report(fake_res, s2) and '| 01-x | 1 | eof | 207.0 |' in markdown_report(fake_res, s2), 'the report lists every reattach')
    print('self-test', 'PASSED' if ok else 'FAILED')
    return ok


NIGHTLY_TICKET_TITLE = '[nightly query suite] failing cases'

# Failure lines are '- <case-id>: <reason>' (failure_ticket_body) — the filing gate reads the
# case ids back out of an open nightly ticket's description to decide whether this run's
# failure set is already reported. Pure, so the self-test can pin it (44f0cafc).
_CASE_ID_RE = re.compile(r'^- ([0-9]{2}-[a-z0-9_-]+): ', re.M)


def ticket_reported_ids(description):
    """The failing case ids a nightly ticket's description reports. Pure."""
    return set(_CASE_ID_RE.findall(str(description or '')))


def nightly_ticket_covers(reported, failing):
    """True when every currently-failing case id is already reported by an OPEN nightly ticket
    (so no new row is filed); any NEW failing id files its own row. An empty failing set or an
    unparsable open description never counts as covered — fail open toward visibility. Pure."""
    failing = {str(i) for i in (failing or [])}
    return bool(failing) and failing <= set(reported)


def nightly_failing_ids(summary):
    """The failing case ids of a run summary ('<id>: <reasons>' failure strings). Pure."""
    return sorted({f.split(':', 1)[0].strip() for f in summary.get('failures', []) if ':' in f})


def failure_ticket_body(summary, run_url=''):
    """The failure ticket's description — synthetic questions only, no user data. Pure."""
    lines = [f"The nightly live query suite (scripts/e2e/query-suite.py, profile {summary.get('profile', 'test')}, seed {summary.get('seed')}) "
             f"had {summary['verdicts']['FAIL']} failing case(s) of {summary['cases']}." + (f" Run: {run_url}" if run_url else ''), '', 'Failures:']
    lines += [f'- {f}' for f in summary.get('failures', [])[:20]]
    lines += ['', 'Reproduce: python3 scripts/e2e/query-suite.py --seed <seed> --categories <category> (runbook docs/E2E_QUERY_SUITE.md). '
              'A failure whose case id an open nightly ticket already reports is deduped; any NEW failing case id files its own row.']
    return '\n'.join(lines)


def profile_refusal(profile, categories):
    """A category outside the profile's allow-list is refused (the owner profile is READ-ONLY integrations). Pure."""
    unknown = [c for c in categories if c not in CATALOG]
    if unknown:
        return f"unknown categories: {', '.join(unknown)}"
    bad = [c for c in categories if c not in PROFILES[profile]['categories']]
    if bad:
        return f"profile '{profile}' does not run: {', '.join(bad)} (allowed: {', '.join(PROFILES[profile]['categories'])})"
    return ''


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--n', type=int, default=12)
    ap.add_argument('--seed', type=int, default=None)
    ap.add_argument('--profile', choices=sorted(PROFILES), default='test', help='test = the canonical test account (default); owner = READ-ONLY integration checks on the owner account')
    ap.add_argument('--categories', default='', help="comma list; default = the profile's categories")
    ap.add_argument('--only', default='', help='comma list of template names to keep (e.g. plaid-read,drive-search) — re-run specific cases')
    ap.add_argument('--concurrency', type=int, default=2)
    ap.add_argument('--max-research', type=int, default=1)
    ap.add_argument('--case-timeout', type=int, default=900, help='client read deadline per stream (s); the run continues server-side')
    ap.add_argument('--settle', type=int, default=300, help='after a client timeout, how long to wait for the answer row (s)')
    ap.add_argument('--out', default='')
    ap.add_argument('--report', default='', help='write a markdown report here')
    ap.add_argument('--base', default=os.environ.get('DIGBY_E2E_BASE', 'https://digby.ai/api'))
    ap.add_argument('--cleanup', action='store_true')
    ap.add_argument('--file-ticket-on-fail', action='store_true', help='on any FAIL, file a "[nightly query suite] failing cases" bug as the run account — deduped only while an open nightly ticket already reports every failing case id (a NEW failing id always files, 44f0cafc)')
    ap.add_argument('--run-url', default=os.environ.get('GITHUB_RUN_URL', ''), help='link recorded in the failure ticket (the nightly workflow passes its run URL)')
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--dry-run', action='store_true')
    ap.add_argument('--self-test', action='store_true')
    a = ap.parse_args()
    if a.self_test:
        sys.exit(0 if self_test() else 1)
    if a.list:
        for cat, fns in CATALOG.items():
            who = ', '.join(p for p, cfg in PROFILES.items() if cat in cfg['categories'])
            print(f"{cat} [{who}]: {', '.join(fn.__name__.replace('tpl_', '') for fn in fns)}")
        print('excluded by design: ' + '; '.join(EXCLUDED_BY_DESIGN))
        return
    profile = PROFILES[a.profile]
    categories = [c.strip() for c in a.categories.split(',') if c.strip()] or list(profile['categories'])
    refused = profile_refusal(a.profile, categories)
    if refused:
        print(refused, file=sys.stderr)
        sys.exit(2)
    if profile.get('force_cleanup'):
        a.cleanup = True
    seed = a.seed if a.seed is not None else random.randrange(1, 10_000)
    api, connected = None, None
    if not a.dry_run:
        email, password = os.environ.get(profile['email_env']), os.environ.get(profile['password_env'])
        if not email or not password:
            print(f"set {profile['email_env']} / {profile['password_env']} (profile '{a.profile}' — never commit credentials)", file=sys.stderr)
            sys.exit(2)
        try:
            api = Api(a.base, email, password)
        except Exception as e:
            print(f'login failed: {e}', file=sys.stderr)
            sys.exit(2)
        if a.profile == 'test':
            # 1f67492f: clear the suite's fixed-name file leftovers BEFORE sampling, so a
            # create ask on a used account is a CREATE, not a refresh of a previous run's
            # file. The owner profile never does this (its cases create nothing).
            found, gone = api.sweep_suite_files()
            if found:
                print(f'pre-run file sweep: {gone}/{found} suite fixed-name file(s) deleted')
            # 6fd4663a: the same problem on the memory side — an earlier run's forget/remember
            # turns leave durable facts and __rejections topic bans on this account; a later
            # run's remember turn then fights its own leftovers ("do you want to lift that
            # ban?"). Clear the suite's own fact keys BEFORE sampling so every run starts
            # from the same memory state. The owner profile never does this.
            facts_cleared, bans_cleared = api.sweep_suite_memory()
            if facts_cleared:
                print(f'pre-run memory sweep: {facts_cleared} suite fact(s) cleared, {bans_cleared} ban list(s)')
        if 'integrations' in categories:
            status = api.connected_integrations()
            connected = {k for k, v in status.items() if v} - SKIP_INTEGRATIONS
            print('integrations connected: ' + (', '.join(sorted(connected)) or 'none') + ' · not connected: ' + (', '.join(sorted(k for k, v in status.items() if not v)) or 'none'))
    cases = sample_cases(a.n, seed, categories, a.max_research, connected)
    if a.only:
        keep = {x.strip() for x in a.only.split(',') if x.strip()}
        cases = [c for c in cases if c['name'] in keep]
    print(f'profile {a.profile} · seed {seed} · {len(cases)} cases · {sum(len(c["turns"]) + (1 if c.get("dig") else 0) for c in cases)} stream requests')
    if a.dry_run:
        for c in cases:
            print(f"{c['id']}: " + ' | '.join(c['turns']) + (' | [Dig deeper]' if c.get('dig') else ''))
        return
    pacer = Pacer()
    results, lock = [], threading.Lock()
    queue = list(cases)

    def worker():
        while True:
            with lock:
                if not queue:
                    return
                case = queue.pop(0)
            try:
                r = run_case(api, pacer, case, a.case_timeout, a.settle)
            except Exception as e:
                r = {'id': case['id'], 'category': case['category'], 'name': case['name'], 'verdict': 'FAIL', 'turns': [{'message': case['turns'][0], 'verdict': 'FAIL', 'reasons': [f'harness error: {type(e).__name__}: {str(e)[:160]}'], 'tools': []}]}
            with lock:
                results.append(r)
                print(f"[{len(results)}/{len(cases)}] {r['id']} → {r['verdict']}", flush=True)
                if a.out:
                    with open(a.out, 'a') as f:
                        f.write(json.dumps(r) + '\n')

    threads = [threading.Thread(target=worker) for _ in range(max(1, min(a.concurrency, 4)))]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    results.sort(key=lambda r: r['id'])
    print()
    print_table(results)
    summary = summarize(results)
    summary['seed'] = seed
    summary['profile'] = a.profile
    print()
    print(json.dumps(summary, indent=2))
    if a.report:
        with open(a.report, 'w') as f:
            f.write(markdown_report(results, summary))
        print(f'report: {a.report}')
    if a.file_ticket_on_fail and summary['verdicts']['FAIL']:
        print('failure ticket: ' + api.file_failure_ticket(NIGHTLY_TICKET_TITLE, failure_ticket_body(summary, a.run_url), failing_ids=nightly_failing_ids(summary)))
    if (summary.get('latency_gate') or {}).get('breaches'):
        print('latency gate BREACHED: ' + '; '.join(summary['latency_gate']['breaches']))
        if a.file_ticket_on_fail:
            print('latency ticket: ' + api.file_failure_ticket(LATENCY_TICKET_TITLE, latency_ticket_body(summary, a.run_url)))
    if a.cleanup:
        ids = [cid for r in results for cid in [r.get('chat_id'), *(r.get('extra_chat_ids') or [])] if cid]
        gone = sum(1 for cid in ids if api.delete_chat(cid))
        print(f'cleanup: deleted {gone} chat(s)')
        if a.profile == 'test':
            # 1f67492f: the same sweep after the run — the files the run just created stay
            # off the account too (only the suite's fixed names; everything else is the
            # account's own).
            found, gone = api.sweep_suite_files()
            if found:
                print(f'cleanup: deleted {gone}/{found} suite fixed-name file(s)')
            # 6fd4663a: same for memory — the facts and topic bans the run's own
            # remember/forget turns just created do not become the next run's blockers.
            facts_cleared, bans_cleared = api.sweep_suite_memory()
            if facts_cleared:
                print(f'cleanup: {facts_cleared} suite fact(s) cleared, {bans_cleared} ban list(s)')
    sys.exit(1 if summary['verdicts']['FAIL'] else 0)


if __name__ == '__main__':
    main()
