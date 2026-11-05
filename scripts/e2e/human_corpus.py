"""
human_corpus.py — realistic, human-written-style chat messages for the live query suite (2026-10-04).

Owner ask: "work on a lot more generic user human like messages with or without required tools to audit all complex
questions messages and everything". Each entry is what a real person types — casual, terse, typo'd, multi-part, vague,
emotional, non-English — across everyday topics. The suite samples them (category `human`, and `human_thread` for
multi-turn conversations with natural follow-ups) and judges every answer with GENERIC checks (query-suite.py
`generic_answer_checks`): leaked internal text, refusals of benign asks, hand-backs, too-short answers to multi-part
asks, the wrong language, a time-sensitive question answered without searching, a Quick-lane act on a high-stakes
topic. Expectations come from per-message FLAGS:

  web    — time-sensitive / current: a web tool (or a prefetch) should ground it (WARN when nothing searched)
  stakes — health / money / legal / safety: the Quick lane must NOT act (FAIL), and a checker lane is preferred
  multi  — several parts / a long deliverable: a short answer is a WARN
  lang   — the message is in this language; the answer should be too (WARN)
  code   — the answer should contain code (WARN)
  kind   — kind=<k>: BENCH-ONLY task-kind override (scripts/e2e/model-bench.py question_kind — a mixed group, or an
           entry a blind classification vote re-filed); this suite ignores it (flags_to_expect)
  vague  — under-specified on purpose: a clarifying question (ask_user) is fine, an error is not

Slots ({city}, …) are filled from SLOTS; `noise()` adds human texture (lowercase, no final punctuation, "hey" / "pls"
/ "thx", one adjacent-letter typo) so no two runs send the exact same text. Pure data + pure helpers — no network.
"""

import random

SLOTS = {
    'city': ['Toronto', 'Montreal', 'Vancouver', 'Calgary', 'Ottawa', 'Halifax', 'Chicago', 'Lisbon', 'Tokyo', 'Mexico City'],
    'cur': ['USD to CAD', 'EUR to CAD', 'CAD to GBP', 'USD to JPY'],
    'league': ['Leafs', 'Raptors', 'Blue Jays', 'Canucks', 'Canadiens'],
    'store': ['Costco', 'IKEA', 'Home Depot'],
    'dog': ['Biscuit', 'Maple', 'Nacho', 'Pickles'],
    'email': [
        "per my last email, i already sent the report twice. please check before asking again.",
        "as i said in the meeting, this was supposed to be done yesterday. not sure why it isn't.",
    ],
    'paragraph': [
        "The city council voted 7 to 4 on Tuesday to approve a new bike lane network covering 40 km of downtown streets. "
        "Supporters said it will cut traffic deaths and emissions; opponents argued it will hurt small businesses that rely "
        "on street parking. Construction starts in spring and should take two years, with a budget of $86 million.",
        "Our Q3 results were mixed. Revenue grew 12% year over year to $4.2M, driven by the enterprise tier, but churn in the "
        "small-business segment rose from 3% to 5%. Marketing spend was 18% over plan. We will pause two campaigns and "
        "focus on onboarding improvements for small customers in Q4.",
    ],
    'bad_sentence': ["me and him goes to the store yesterday and buyed alot of stuffs", "their going to there house later, its gonna be fun"],
}

# Each entry: (group, text, flags). Flags: web, stakes, multi, lang=<code>, code, vague, kind=<k> (bench-only).
CORPUS = [
    # ── everyday lookups (current / time-sensitive) ──
    ('lookup', "is it gonna rain in {city} tomorrow", {'web'}),
    ('lookup', "what's the {cur} rate right now", {'web'}),
    ('lookup', "did the {league} win last night", {'web'}),
    ('lookup', "when does daylight saving time end this year in canada", {'web'}),
    ('lookup', "is {store} open on sunday in {city}", {'web'}),
    ('lookup', "what's bitcoin at today", {'web'}),
    ('lookup', "what movies are in theatres this weekend", {'web'}),
    ('lookup', "how much is the newest iphone in canada", {'web'}),
    # ── how-to (no tools needed) ──
    ('howto', "how do i get red wine out of a white carpet", set()),
    ('howto', "how long do i boil an egg if i want the yolk runny", set()),
    ('howto', "best way to clean a cast iron pan without ruining it", set()),
    ('howto', "how do i ask my boss for a raise without sounding greedy", {'kind=advice'}),
    ('howto', "how should i budget if i get paid every two weeks", {'multi', 'kind=advice'}),
    ('howto', "my wifi keeps dropping every few minutes, what should i check", {'multi'}),
    # ── writing ──
    ('writing', "write a short birthday message for my coworker who loves hiking", set()),
    ('writing', "make this sound less passive aggressive: \"{email}\"", set()),
    ('writing', "write a 4 line poem about my dog {dog} who steals socks", set()),
    ('writing', "help me write the opening paragraph of a cover letter for a junior data analyst job", set()),
    ('writing', "give me 3 instagram captions for a beach sunset pic", set()),
    # ── explain ──
    ('explain', "explain how a mortgage works like i'm 15", set()),
    ('explain', "what's the actual difference between weather and climate", set()),
    ('explain', "why do we have leap years", set()),
    ('explain', "how does a vaccine actually work in your body", set()),
    ('explain', "what is quantum computing in normal words", set()),
    # ── planning (multi-part deliverables) ──
    ('plan', "plan a 3 day trip to {city} on a budget, i like food and museums", {'multi', 'web'}),
    ('plan', "make me a weekly meal plan for a vegetarian who hates mushrooms", {'multi'}),
    ('plan', "i have 2 hours tonight, help me plan a productive evening", set()),
    ('plan', "build me a 4 week beginner running plan, i can run maybe 1km right now", {'multi'}),
    # ── comparisons / decisions ──
    ('compare', "iphone or pixel? i mostly take photos and text", set()),
    ('compare', "renting vs buying in {city} right now — what should i be thinking about", {'stakes', 'multi'}),
    ('compare', "should i learn python or javascript first", set()),
    ('compare', "tesla model 3 vs hyundai ioniq 6 for a canadian winter", {'web'}),
    # ── health (stakes) ──
    ('health', "i've had a headache for 3 days and now some blurry vision, should i be worried", {'stakes'}),
    ('health', "how much ibuprofen can i take in a day", {'stakes'}),
    ('health', "is it ok to work out with a mild fever", {'stakes'}),
    ('health', "my toddler just swallowed a small magnet what do i do", {'stakes'}),
    # ── money / legal (stakes) ──
    ('money', "can my landlord raise my rent 10% in ontario", {'stakes', 'web'}),
    ('money', "how do i report crypto gains on my canadian taxes", {'stakes'}),
    ('money', "is it worth paying off my mortgage early or should i invest instead", {'stakes'}),
    ('money', "my employer hasn't paid me in 2 weeks, what are my options in BC", {'stakes'}),
    # ── math / logic ──
    ('math', "if i save $250 a month at 5% interest how much will i have after 10 years", set()),
    ('math', "what's an 18% tip on $86.40 split between 3 people", set()),
    ('math', "train leaves at 3:45pm and the trip is 2h50m, when does it get in", set()),
    ('math', "solve 3x + 7 = 2x - 5 and show the steps", set()),
    # ── code ──
    ('code', "why does my python script say IndexError: list index out of range", {'code'}),
    ('code', "write a sql query for the top 5 customers by total spend from an orders table", {'code'}),
    ('code', "what does this regex do: ^\\d{3}-\\d{4}$", set()),
    ('code', "convert this to javascript: def add(a, b): return a + b", {'code'}),
    # ── pasted text ──
    ('paste', "summarize this in 2 bullets:\n\n{paragraph}", set()),
    ('paste', "fix the grammar: {bad_sentence}", set()),
    # ── non-English (answer in kind) ──
    ('lang', "comment dire « je suis en retard » poliment dans un email professionnel ?", {'lang=fr'}),
    ('lang', "¿cuál es la capital de Australia y por qué no es Sídney?", {'lang=es', 'kind=lookup'}),
    ('lang', "was ist der unterschied zwischen „seit“ und „seid“?", {'lang=de', 'kind=explain'}),
    ('lang', "translate 'where is the train station' to japanese and show how to pronounce it", set()),
    # ── opinion / contested ──
    ('opinion', "is social media actually bad for teenagers", set()),
    ('opinion', "was the industrial revolution good or bad for workers", set()),
    ('opinion', "should canada move to a 4 day work week", set()),
    # ── emotional / advice ──
    ('advice', "i'm really stressed about exams next week, any tips", set()),
    ('advice', "my friend hasn't texted me back in a week, should i be worried", set()),
    ('advice', "how do i tell my roommate they're too loud without making it weird", set()),
    # ── vague on purpose ──
    ('vague', "help", {'vague'}),
    ('vague', "what do you think", {'vague'}),
    ('vague', "can you do the thing from before", {'vague'}),
    ('vague', "fix it", {'vague'}),
    # ── trivia ──
    ('trivia', "who painted the mona lisa", set()),
    ('trivia', "how many bones are in the human body", set()),
    ('trivia', "what's the tallest mountain in canada", set()),
    ('trivia', "why is the ocean salty", {'kind=explain'}),
    # ── local / recommendations (current) ──
    ('local', "good ramen spots in {city}?", {'web'}),
    ('local', "kid friendly stuff to do in {city} this weekend", {'web'}),
    # ── current events ──
    ('news', "what's going on with interest rates in canada", {'web'}),
    ('news', "latest news on AI regulation", {'web'}),
    ('news', "who's the current prime minister of the uk", {'web'}),
    # ── complex / research-ish ──
    ('complex', "compare the healthcare systems of canada, the uk and germany in a table", {'multi'}),
    ('complex', "pros and cons of nuclear vs solar for a small country, be honest about costs", {'multi'}),
    ('complex', "give me the history of the internet in 10 key milestones", {'multi', 'kind=explain'}),
    ('complex', "i'm starting a small coffee roasting business from home in ontario — what licenses, costs and first steps should i know about", {'multi', 'stakes', 'web', 'kind=advice'}),
    # ── shopping ──
    ('shopping', "best budget noise cancelling headphones under $150", {'web', 'kind=advice'}),
    ('shopping', "what laptop should a nursing student get", {'kind=advice'}),
    # ── cooking ──
    ('cooking', "what can i make with chicken thighs, rice and a lemon", set()),
    ('cooking', "substitute for buttermilk in pancakes?", set()),
    # ── kids / homework ──
    ('homework', "help my 10 year old understand fractions", set()),
    ('homework', "explain photosynthesis for a grade 5 science project", set()),
]

# Multi-turn conversations: (group, [turn, turn, …], flags per turn).
THREADS = [
    ('thread-trip', ["plan a weekend in {city} for two, mid budget", "make it cheaper", "add one day trip outside the city"], [{'multi', 'web'}, set(), {'web'}]),
    ('thread-mortgage', ["explain how a mortgage works like i'm 15", "ok but what's amortization", "give me an example with real numbers"], [set(), set(), set()]),
    ('thread-message', ["write a short birthday message for my coworker who loves hiking", "shorter and funnier", "now in french"], [set(), set(), {'lang=fr'}]),
    ('thread-weather', ["what's the weather in {city} today", "what about the weekend?", "should i bring an umbrella then"], [{'web'}, {'web'}, set()]),
    ('thread-phone', ["iphone or pixel? i mostly take photos and text", "what about battery life", "ok which one would you pick for me"], [set(), set(), set()]),
    ('thread-recipe', ["what can i make with chicken thighs, rice and a lemon", "i don't have a lemon actually", "how long in the oven"], [set(), set(), set()]),
]

CASUAL_PREFIX = ['', '', '', 'hey ', 'quick q: ', 'ok so ', 'hi! ', 'question — ']
CASUAL_SUFFIX = ['', '', '', ' pls', ' thx', ' thanks!', ' ?']


def fill(text, rng):
    """Fill {slot}s from SLOTS (unknown braces are left alone — regexes, code). Pure."""
    out = text
    for key, values in SLOTS.items():
        token = '{' + key + '}'
        while token in out:
            out = out.replace(token, rng.choice(values), 1)
    return out


def noise(text, rng, level=0.5):
    """Human texture: maybe lowercase, drop the final '?', add a casual prefix / suffix, one adjacent-letter typo in a
    long word. Never touches pasted / quoted / code content (anything after a newline or inside quotes is kept). Pure."""
    if rng.random() > level or '\n' in text or '"' in text or '«' in text or '„' in text or '^' in text or 'def ' in text:
        return text
    t = text
    if rng.random() < 0.5:
        t = t[0].lower() + t[1:]
    if t.endswith('?') and rng.random() < 0.5:
        t = t[:-1]
    words = t.split(' ')
    long_idx = [i for i, w in enumerate(words) if len(w) >= 6 and w.isalpha()]
    if long_idx and rng.random() < 0.5:
        i = rng.choice(long_idx)
        w = words[i]
        j = rng.randrange(1, len(w) - 2)
        words[i] = w[:j] + w[j + 1] + w[j] + w[j + 2:]
        t = ' '.join(words)
    suffix = rng.choice(CASUAL_SUFFIX)
    if suffix.strip() == '?' and t.rstrip().endswith('?'):
        suffix = ''
    return rng.choice(CASUAL_PREFIX) + t + suffix


def flags_to_expect(flags):
    """CORPUS flags → the suite's per-turn expectation dict. Pure."""
    exp = {'generic': True}
    for f in flags:
        if f == 'web':
            exp['web_expected'] = True
        elif f == 'stakes':
            exp['no_quick_act'] = True
        elif f == 'multi':
            exp['multi_part'] = True
        elif f == 'code':
            exp['code_block'] = True
        elif f == 'vague':
            exp['ask_ok'] = True
        elif f.startswith('lang='):
            exp['lang'] = f.split('=', 1)[1]
    return exp


def human_case(rng):
    """One single-turn human message case (random entry, filled + noised). Pure over rng."""
    group, text, flags = rng.choice(CORPUS)
    return {'category': 'human', 'name': group, 'turns': [noise(fill(text, rng), rng)], 'expect': [flags_to_expect(flags)]}


def thread_case(rng):
    """One multi-turn human conversation (follow-ups reference the earlier turns). Pure over rng."""
    group, turns, flags = rng.choice(THREADS)
    filled = [noise(fill(t, rng), rng, level=0.3) for t in turns]
    return {'category': 'human_thread', 'name': group, 'turns': filled, 'expect': [flags_to_expect(f) for f in flags]}
