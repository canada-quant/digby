# digby.ai — keyword map and page-to-intent assignment

Owner goal: `252a1d17` (Deep SEO build-out for digby.ai) · todo `2fe8ed80`
Companion documents: `docs/seo/COMPETITOR-GAP.md` (the six-lever baseline of record),
`docs/SEO_PLAN_2026-10-14.md` (the original plan + shipped IA).

Every page below already exists in `frontend/lib/site/content.ts` (or is generated from it —
see §5). One entry there drives the page, its `<title>`/description, its `keywords` metadata,
its JSON-LD, its footer/menu links and its sitemap row, so this map is the single place to read
what a page is *for*.

**Claims discipline binds every line of this document** (it is enforced by
`frontend/lib/site/content.test.ts`): no "compliant"/"certified" language, no model vendor names
in visible copy, "stored in Canada" means AWS Canada Central (Montréal), and never a bare
"no data leaves Canada".

---

## 1. The five intent clusters

Search demand for this market sorts into five clusters. The clusters are the reason the site has
the shape it has: one page cannot rank for "what is sovereign AI" *and* "AI for a Winnipeg law
firm", because the visitor is a different person at a different moment.

| # | Cluster | What the searcher wants | Money? | Page family |
|---|---|---|---|---|
| C1 | **Definition / research** | "what is sovereign AI", "data residency vs sovereignty", "open weight vs closed" | no | `/learn/*` (7 guides) |
| C2 | **Product evaluation** | "private AI Canada", "Canadian AI chatbot", "ChatGPT alternative Canada" | yes | `/private-ai`, `/canadian-ai-chatbot`, `/chatgpt-alternative`, `/features`, `/sovereign-ai` |
| C3 | **Compliance / procurement** | "PIPEDA AI requirements", "Law 25 AI", "PHIPA chatbot", "OSFI E-23 AI", "AI data residency Canada" | yes (enterprise) | `/compliance`, `/infrastructure`, `/ai-for-business`, `/self-hosted-ai` |
| C4 | **Vertical / sector** | "AI for law firms Canada", "AI for credit unions", "AI for clinics Canada" | yes (highest ACV) | `/industries` hub + 6 sector pages |
| C5 | **Comparison / vendor shopping** | "digby vs augure", "cohere north alternative", "discreetly ai alternative", "copilot Canada data" | yes (late funnel) | 5 `/digby-vs-*` pages |

**Local intent (`C4 × city`)** is the programmatic layer — §5. It is a *sub-cluster* of C4, not a
separate family: the searcher is a procurement person in a specific province whose statute name
matters to them.

### 1a. The six competitor levers, as intent clusters

The six columns of `docs/seo/COMPETITOR-GAP.md` map one-to-one onto the query clusters this site has
to own. This table is the bridge between that sheet and the page assignment in §3: each row says what
a competitor winning that lever captures, and which page answers it here.

| Lever (from the gap sheet) | The query cluster it captures | Where Digby answers it | Owner-blocked? |
|---|---|---|---|
| (a) Named model line | **"open-weight vs proprietary Canadian model"** — a buyer asking whether the model is inspectable, tunable, portable, or a vendor secret | `/open-source-ai`, `/sovereign-ai`, `/learn/open-weight-vs-closed-ai-models` | ✅ **RESOLVED 2026-10-30 — owner: remove.** Names are out for good (not pending); the *open vs proprietary* argument is written and is what wins the cluster |
| (b) Published CAD pricing tiers | **"private AI pricing Canada"** · **"on-prem AI cost"** — a buyer with a budget line and no price to compare | `/faq`, `/private-ai` + 30 city pages (the cost answer), the `/digby-vs-*` price rows, `/self-hosted-ai` (self-host economics) | ✅ **RESOLVED 2026-10-30 — owner: "Free to start — publish a $0 entry point and keep larger engagements on 'contact us'"** (`oq_88a750bc`). $0 published in CAD; above $0 = Contact us, **no ladder**. One constant |
| (c) Hard cost / efficiency claim | **"on-prem vs public cloud AI cost"** — a buyer asked to justify spend against a public-cloud alternative | `/infrastructure`, `/self-hosted-ai` | partially — the hardware claim is written; a *dollar* figure needs (b) |
| (d) Bilingual EN/FR | **FR/EN cluster** — "IA souveraine", "assistant IA Québec", "IA confidentielle Canada"; a buyer whose working language is French | `/ia-souveraine-canada` (the one FR page, with a reciprocal hreflang pair) | no — but a real `/fr` subtree is a translation project, not an SEO fix |
| (e) Named regulatory frameworks | **"PIPEDA AI"** · **"Law 25 AI"** · **"PHIPA compliant chatbot"** — a privacy officer checking whether their statute is even understood | `/compliance` + 6 sector pages + the 3 city verticals | no — **closed**, and always phrased as "designed to support / aligned with", never "compliant" or "certified" |
| (f) "No US parent" trust line | **"data residency Canada"** — "where is my data stored", "does AI training use my data", "Canadian data residency" | `/infrastructure`, `/private-ai`, `/learn/where-your-data-goes`, `/learn/canadian-data-residency-ai` | no — **closed as a different claim**: storage location and inference location stated separately |

Two notes that keep this table honest:

- **"PHIPA compliant chatbot" is a query, not a claim.** It is written above as the searcher's words.
  Digby holds no PHIPA certification and the pages say so; the cluster is answered on `/compliance`
  and `/industries-healthcare` by explaining what PHIPA actually requires of a custodian and where
  Digby's data sits — never by asserting the word "compliant" about ourselves.
- **Lever (a) and the open-weight argument are different things.** The *positioning* ("open-weight,
  tunable, no single vendor owns the intelligence") is live on three pages today. The *names* are the
  owner's call and appear nowhere. A competitor naming its models does not win the open-vs-proprietary
  question; it answers the opposite one.

---

## 2. What each competitor ranks for (as of the 2026-10-29 baseline)

Read from `docs/seo/COMPETITOR-GAP.md`. Treat this as *which intent cluster they occupy*, not as a
claim about their actual SERP positions — we have no rank-tracking account, and this document must
not pretend otherwise.

| Competitor | Clusters they clearly occupy | Query they are built to win | What they do **not** answer |
|---|---|---|---|
| **Augure** (`augureai.ca`) | C3, C4 (legal), C5 | "sovereign AI Canada", "Canadian AI model", "Canadian sovereign AI pricing" | Throughput / cost numbers; any public benchmark; on-prem self-hosting (enterprise custom only) |
| **Discreetly** (`discreetlyai.com`) | C3, C4 (manufacturing, healthcare, legal, financial) | "on-premises AI", "air-gapped AI Canada", "PIPEDA AI" | Any price or number; hosted start; a named model |
| **Micrologic** (`micrologic.ca`) | C3 (infrastructure angle) | "sovereign private AI", "VMware NVIDIA private AI" | Named regulatory frameworks; published pricing |

**The empty slot:** framework-named **and** number-backed. Discreetly names frameworks with no
number; Micrologic has numbers with no framework; Augure has pricing with only a *time* claim.
That intersection is the positioning the C3/C4 pages take, and it is the reason `/infrastructure`
(storage **and** inference location, with real hardware classed honestly) is a competitive page and
not a footnote.

**Two levers are owner-decided and cannot be written yet** — see §6.

---

## 3. Page-to-keyword assignment (existing pages)

`Primary` = the one query the page's title/H1 is built around. `Secondary` = supporting intents that
belong on the same page. Every page's `keywords` array in `content.ts` must contain at least its
primary plus its strongest secondary — `content.test.ts` pins the four Canada head terms.

### C1 — Definition / research (`/learn/*`)

| Page | Primary | Secondary |
|---|---|---|
| `/learn/what-is-sovereign-ai` | what is sovereign AI | AI sovereignty Canada, sovereign AI definition |
| `/learn/where-your-data-goes` | where is my AI chat data stored | AI data flow, AI chatbot privacy |
| `/learn/canadian-data-residency-ai` | AI data residency Canada | Canadian data residency, where is chatbot data stored |
| `/learn/open-weight-vs-closed-ai-models` | open weight vs closed AI models | open source AI models, model lock-in |
| `/learn/choosing-a-private-ai-chatbot` | private AI chatbot Canada | best private AI chatbot, secure AI chatbot |
| `/learn/ai-at-work-in-canada-checklist` | AI policy Canada business | AI governance Canada, PIPEDA AI, Law 25 AI |
| `/learn/how-digby-double-checks-answers` | AI hallucinations | accurate AI answers, AI fact checking |

### C2 — Product evaluation

| Page | Primary | Secondary |
|---|---|---|
| `/` (chat) | Canadian AI assistant | digby ai, ai chat canada |
| `/features` | AI assistant features | AI chatbot with web search, AI PDF analysis |
| `/private-ai` | private AI Canada | private AI chatbot, secure AI chat Canada, Canadian private AI |
| `/canadian-ai-chatbot` | Canada AI chatbot | Canadian AI chatbot, best AI chatbot Canada |
| `/chatgpt-alternative` | ChatGPT alternative Canada | Canadian ChatGPT, Canadian alternative to ChatGPT |
| `/sovereign-ai` | sovereign AI Canada | sovereign Canada AI models, Canadian sovereign AI, AI sovereignty Canada |
| `/ia-souveraine-canada` (fr-CA) | IA souveraine Canada | intelligence artificielle canadienne, assistant IA Québec |
| `/open-source-ai` | open source AI chatbot | open weight AI models, open source ChatGPT alternative |
| `/deep-research` | AI deep research | AI research assistant, AI literature review |
| `/ai-coding-agent` | AI coding agent | AI software engineer, autonomous coding agent |
| `/integrations` | AI assistant integrations | AI Gmail assistant, AI Slack assistant, MCP servers |
| `/digby-kids` | AI tutor for kids | safe AI for kids, AI homework helper Canada |
| `/download` | Digby download | AI assistant Mac app, AI assistant Windows app |
| `/about` | about Digby | Canadian AI company |
| `/faq` | Digby FAQ | is Digby free, where is Digby data stored |

### C3 — Compliance / procurement

| Page | Primary | Secondary |
|---|---|---|
| `/compliance` | AI compliance Canada | PIPEDA AI requirements, Quebec Law 25 AI, PHIPA AI, OSFI E-23 AI, Canadian AI data residency compliance |
| `/infrastructure` | Canadian AI infrastructure | AI inference Canada, NVIDIA GPU Canada AI, sovereign AI infrastructure Canada, Canadian AI data centre |
| `/ai-for-business` | AI for Canadian business | AI data residency Canada, secure AI for business Canada, enterprise AI Canada |
| `/self-hosted-ai` | self hosted AI Canada | on-premise AI assistant, private LLM Canada, self-hosted ChatGPT alternative |

### C4 — Vertical / sector

| Page | Primary | Secondary |
|---|---|---|
| `/industries` (hub) | AI for Canadian industries | private AI by industry Canada, sector-specific AI Canada |
| `/industries-legal` | AI for lawyers Canada | legal AI Canada, private AI law firm Canada, contract review AI Canada |
| `/industries-healthcare` | AI for healthcare Canada | PHIPA AI Canada, private AI for clinics Canada |
| `/industries-credit-unions` | AI for credit unions Canada | OSFI E-23 AI, private AI financial services Canada |
| `/industries-public-sector` | AI for public sector Canada | government AI Canada, AI for municipalities Canada, FOIP AI Alberta, bilingual AI Canada |
| `/industries-manufacturing` | AI for manufacturing Canada | manufacturing AI Canada, ISO 9001 AI, AI for plant maintenance Canada |
| `/industries-first-nations` | AI for First Nations Canada | Indigenous data sovereignty AI, community-controlled AI Canada, band administration AI |

### C5 — Comparison

| Page | Primary | Secondary |
|---|---|---|
| `/digby-vs-chatgpt` | Digby vs ChatGPT | ChatGPT Canada data, is ChatGPT data stored in Canada |
| `/digby-vs-microsoft-copilot` | Digby vs Copilot | Microsoft 365 Copilot Canada, Copilot data residency Canada |
| `/digby-vs-cohere-north` | Digby vs Cohere | Cohere North alternative, Canadian enterprise AI |
| `/digby-vs-augure-ai` | Digby vs Augure | Augure AI alternative, Canadian sovereign AI comparison |
| `/digby-vs-discreetly-ai` | Digby vs Discreetly | Discreetly AI alternative, on-premise AI Canada, air-gapped AI Canada |

---

## 4. Internal-link model (what §3 implies)

Hub/spoke, with every spoke reachable from the hub's *body* (not only its "related" cards):

```
/industries  ──▶ 6 sector pages
                    │
                    ├─▶ the compare page that names that sector's competitor
                    │      (legal → digby-vs-augure-ai, manufacturing → digby-vs-discreetly-ai)
                    ├─▶ /compliance        (the framework the sector is regulated by)
                    ├─▶ /infrastructure    (where storage and inference actually are)
                    └─▶ /private-ai        (the product in plain language)
```

Every page carries **≥ 3 contextual inbound links** in body copy (`sections[].links`) — the
`related` cards alone do not count, because they are boilerplate on every page and search engines
weigh them accordingly. `content.test.ts` pins this floor.

---

## 5. City × vertical matrix (programmatic layer)

Ten Canadian metros × the three verticals with the clearest provincial regulatory hook. 30 pages,
generated from a data table in `content.ts` — **not** hand-written 30 times, and not a swap-the-city
template: each cell carries its own statute, its own sector context and its own first paragraph.

| City | Province | Health statute | Public-sector statute | Legal regulator | Vertical pages |
|---|---|---|---|---|---|
| Victoria | BC | PIPA BC | FOIPPA | Law Society of BC | legal · healthcare · public-sector |
| Vancouver | BC | PIPA BC | FOIPPA | Law Society of BC | legal · healthcare · public-sector |
| Calgary | AB | Health Information Act | FOIP | Law Society of Alberta | legal · healthcare · public-sector |
| Edmonton | AB | Health Information Act | FOIP | Law Society of Alberta | legal · healthcare · public-sector |
| Winnipeg | MB | PHIA Manitoba | FIPPA Manitoba | Law Society of Manitoba | legal · healthcare · public-sector |
| Toronto | ON | PHIPA | MFIPPA | Law Society of Ontario | legal · healthcare · public-sector |
| Ottawa | ON | PHIPA | MFIPPA | Law Society of Ontario | legal · healthcare · public-sector |
| Montréal | QC | Law 25 (private sector) | Law 25 / access acts | Barreau du Québec | legal · healthcare · public-sector |
| Québec City | QC | Law 25 (private sector) | Law 25 / access acts | Barreau du Québec | legal · healthcare · public-sector |
| Halifax | NS | PHIA Nova Scotia | FIPPA Nova Scotia | Nova Scotia Barristers' Society | legal · healthcare · public-sector |

Slug shape: `/ai-<vertical>-<city>` — e.g. `/ai-legal-toronto`, `/ai-healthcare-montreal`,
`/ai-public-sector-halifax` (ASCII, no accents: Montréal → `montreal`, Québec City → `quebec-city`).

### The anti-thinness rules these pages must satisfy

A programmatic page is a doorway page — and a liability — the moment the only thing that varies is
the city name. Each page therefore carries, at minimum:

1. **A provincial statute the reader recognises** (the table above) and one sentence on what it
   actually requires of them, written in plain language.
2. **A local-context paragraph** that could not be written about another city — the sector mix, the
   bilingual reality, the regulator's local posture.
3. **The same honest infrastructure line everywhere**: storage in Canada (AWS Canada Central,
   Montréal), inference on Canadian-located NVIDIA GPU hardware operated in Canada, and — only
   where true — the proximity note. The Victoria lab is a real fact and Victoria may say so; no
   city gets a fabricated office, datacenter or customer.
4. **≥ 500 words of its own copy**, verified by a test, not by eyeball.
5. **Self-canonical + in the sitemap at priority 0.6**, `lastmod` = the page's real `updated` date.
6. **No city page ships for a vertical with nothing local to say.** If a cell cannot clear rules
   1–4, it is dropped from the table rather than padded.

---

## 6. The two owner levers (2026-10-30 status)

The owner ruled on this copy layer on **2026-10-30**: **"no names models and it's free"**.
That settles one lever and leaves one gated. Read this table before writing copy for either.

| Lever | What it needs | State (2026-10-30) |
|---|---|---|
| (a) Named model variants | A decision to name Digby's tuned model line publicly | ✅ **RESOLVED — owner: REMOVE.** No named-variant row ships, and none is parked as a placeholder. |
| (b) Published CAD pricing tiers | A decision to publish per-seat CAD prices | ✅ **RESOLVED 2026-10-30** — `oq_88a750bc` answered: $0 entry point published, everything above routed to "Contact us". |

### (a) Named model variants — RESOLVED, removed (do not re-add)

The owner said **"no names models"**. That is a ruling, not a pending decision, so the lever is
**closed by deletion**, not left wired-and-empty: `MODEL_LINE` / `NamedModel` and the whole
`frontend/lib/site/models-pricing.ts` module are gone. **A null placeholder is an invitation for a
later lane to fill it in; a deleted one cannot be filled in.**

What this means for copy:
- No Digby-branded variant name (`Digby fast`, `Digby deep`, `Digby research` — the shapes the old
  placeholder anticipated) anywhere in rendered copy, and no model vendor name either
  (`Kimi`, `GLM`, `DeepSeek`, `Qwen`, `Moonshot`). `frontend/lib/site/pricing.test.ts` pins both on
  **rendered** strings, so an SEO `keywords` entry cannot smuggle one in.
- The **open-weight vs proprietary argument is untouched and is still the answer to the cluster** —
  it was never the names. `/open-source-ai`, `/sovereign-ai` and
  `/learn/open-weight-vs-closed-ai-models` keep making it, and they are what actually wins lever (a)'s
  query cluster. Naming our models would have answered a different question.
- `keywords` arrays keep the vendor terms on purpose (SEO, owner 2026-10-16). The pin is on visible
  copy, not on metadata.

### (b) Published CAD pricing — RESOLVED, published as a $0 entry point

**The owner answered `oq_88a750bc` on 2026-10-30, verbatim:**

> **"Free to start — publish a $0 entry point and keep larger engagements on 'contact us'"**

So lever (b) is **CLOSED, and closed on the cautious option**. Not "free, full stop" (that was
option 1 and it was *not* chosen): the site publishes **$0 to start** and routes everything above it —
more seats, more volume, a dedicated deployment — to **"Contact us"**. Concretely, in copy:

- `$0` / "free to start" IS published, in CAD, as the headline number.
- **No named tiers, no Pro/Max/Enterprise ladder, no dollar figure above $0.** Augure's CAD tier
  ladder (Free $0 · Pro $20 · Max $80) is precisely what this ruling does *not* copy — we win the
  price-transparency row by being plain about the entry point, not by matching their ladder.
- Everything above the entry point is **quoted, never listed**.

All of it reads ONE constant — `frontend/lib/site/pricing.ts` →
`PUBLISHED_PRICE_CAD_PER_MONTH` (now `0`). Changing that single value still flips every surface
together: the comparison price cells, the visible cost answers in **both languages**, the FAQPage
`acceptedAnswer`, and the `Service.offers` schema node. `null` remains a supported value (the row
falls back to "Quoted on request" and the schema emits no money property), so the constant stays a
one-line lever in either direction.

Where the row is live: the five `/digby-vs-*` tables that carry a price row (`chatgpt`,
`microsoft-copilot`, `cohere-north`, `discreetly-ai`, `augure-ai`), and the cost FAQ on
`/private-ai`, `/faq`, `/chatgpt-alternative`, `/digby-vs-chatgpt` and all **30 city pages**. The
fr-CA page (`/ia-souveraine-canada`) publishes the same ruling in French (`pricingAnswerFr()`, same
constant), which replaced a live "Digby est-il gratuit ? … Oui" entry.

**Do not re-ask this.** The pricing question is answered and recorded; treat any future "should we
publish a price?" as settled. If a figure above $0 ever needs publishing, that is a *new* owner
decision (a real tier), not a re-read of this one.

**Historical note on the cards** (so it is not re-derived): `oq_bc1d12fe` — the card the original
work order named — was **DISMISSED by the system as superseded** and was never a ruling. The card
that actually decided this is **`oq_88a750bc`**. There was also a real bug fixed on the way: the
site emitted `offers: { price: '0', priceCurrency: 'CAD' }` in JSON-LD *before* any ruling existed,
i.e. a $0 claim published by nobody's decision. It is correct now **because** the owner decided it,
and `null` emits no money property at all as a regression pin.

Everything not dependent on (b) — frameworks, infrastructure, bilingual, trust line, vertical depth,
named-model removal — is buildable now and is built.

### The gap thesis, so the next lane does not re-derive it

Measured against the three competitors on `docs/seo/COMPETITOR-GAP.md` row 1 (fetched 2026-10-29):

> **"Framework-named *and* number-backed" is an empty slot in this market.**

Discreetly names frameworks but publishes no number. Micrologic publishes numbers but names no
framework. Augure publishes CAD pricing but backs it with a *time* claim, not a dollar claim. No
competitor owns both halves of the same row.

Digby holds the framework half honestly (`/compliance` + six sector pages + three city verticals name
PIPEDA, Law 25, PHIPA, OSFI E-23 — always "designed to support / aligned with", never "compliant"),
and the infrastructure number (`/infrastructure`: the GPU class and where it runs).

**As of 2026-10-30 the empty slot is filled.** The one missing half was a published price; the owner
answered `oq_88a750bc` ("free to start — publish a $0 entry point and keep larger engagements on
'contact us'") and the site now publishes `$0` in CAD on every price-comparing page, routing above it
to "Contact us". So Digby is the only one of the four that is **framework-named AND number-backed in
the same row** — the position the whole map was built to take. Do not re-derive this thesis and do
not re-ask the pricing question: both are decided and recorded here.

Note the shape that won it, because it is easy to lose on a future edit: the claim is **"free to
start"**, not "free". Augure backs its ladder with a time claim; we back ours with a *plain entry
point plus an honest quote path*. Matched tiers were explicitly declined — reintroducing a
Pro/Max/Enterprise ladder would forfeit the differentiator, not extend it.

---

## 7. Maintenance

- **Weekly:** `docs/seo/COMPETITOR-GAP.md` is re-checked against the three competitor domains by
  the fleet's weekly watch (schedule `ad86d09f`); a moved lever appends a dated row, and the
  affected pages are updated from it.
- **On every page change:** bump the page's `updated` date — it is the sitemap `lastmod` and a
  stale one teaches crawlers to ignore the feed.
- **On every new page:** add one entry to `SITE_PAGES`; the page, its JSON-LD, its footer link, its
  sitemap row and its hreflang pair all follow from that one entry. Then add ≥ 3 contextual inbound
  links from existing pages in the same change — an orphan page is a page that does not rank.