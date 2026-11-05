# digby.ai — Competitor Gap Sheet

Owner: Fleet Supervisor · Goal: `252a1d17` (Deep SEO build-out for digby.ai) · Project: crossmodel

This file is the **baseline of record** for the weekly competitor watch (schedule `ad86d09f`, Wednesdays).
Every row below was read from the competitor's own served page on the fetch date in the header.
The watch diffs the six levers against the newest row; the SEO lane folds any movement into the pages.

**Digby's own column is measured from the repo, not asserted** — each value below names the file
or commit that produced it, so a future run can tell "we improved" from "someone edited the table".

---

## Row 1 — 2026-10-29 (competitors fetched 19:44Z; Digby column re-measured 20:20Z)

Sources fetched fresh today: `https://augureai.ca/`, `https://discreetlyai.com/`,
`https://micrologic.ca/en/products/private-ai/`, and — for our own side —
`https://digby.ai/sitemap.xml` (live) plus the repo at `main` + this branch.

| Lever | Discreetly | Augure | Micrologic | Digby today |
|---|---|---|---|---|
| (a) Named model / product line | ❌ no named models | ✅ Ossington 5 · Tofino 3 (Rosedale One also referenced) | ⚠️ "Cirrus Private AI" — a product name, not models | ❌ **RESOLVED 2026-10-30 — owner: REMOVE.** Nothing named, nothing parked; the placeholder was DELETED, not left null |
| (b) Published CAD pricing tiers | ❌ none public ("fixed monthly infrastructure cost") | ✅ Free $0 · Pro $20/mo · Max $80/mo · Enterprise custom, no credit card | ❌ none public | ✅ **PUBLISHED 2026-10-30 — owner ruling (`oq_88a750bc`): "Free to start — publish a $0 entry point and keep larger engagements on 'contact us'".** $0 IS published in CAD on every price-comparing page; above $0 = "Contact us", **deliberately no tier ladder** |
| (c) Hard cost / efficiency claim | ❌ none quantified | ⚠️ time, not dollars ("40 contracts in a single afternoon" class claim) | ✅ "up to 1/3 the cost" of public cloud · "78% average increase in operating efficiency" | ⚠️ **partial** — no cost number; a real INFRASTRUCTURE number exists and is now stated (`/infrastructure`, 2026-10-28) |
| (d) Bilingual EN/FR | ✅ multilingual incl. FR | ✅ full EN/FR | ✅ EN/FR toggle | ⚠️ **partial** — one French page (`/ia-souveraine-canada`) with a reciprocal `hreflang` pair + `x-default`, pinned by test. No `/fr` subtree. |
| (e) Named regulatory frameworks | ✅ PIPEDA · Law 25 · HIPAA · ISO 9001/45001 · IATF 16949 | ✅ Law 25 · PIPEDA · CPCSC | ❌ not named on the product page | ✅ **named, with the honest limit** — PIPEDA, Law 25, PHIPA, OSFI E-23 on `/compliance` + six sector pages, and the same page states Digby holds no certification for any of them |
| (f) "No US parent / no data to US" trust line | ✅ zero data exposure, on-prem, source attribution | ✅ no US corporate parent, no data to US | ✅ sovereign control, no lock-in | ✅ **different, stronger claim** — storage in Canada (AWS Canada Central, Montréal) AND inference on Canadian-located NVIDIA GPU hardware operated from Canada, split explicitly on `/infrastructure`. Not "no US parent" (we do not claim what we cannot evidence). |

### The finding that matters

**No competitor owns both halves of the same row.** Discreetly names frameworks but publishes no
number. Micrologic publishes numbers but names no framework. Augure publishes pricing but only a
*time* claim, not a dollar claim.

**"Framework-named *and* number-backed" is an empty slot in this market** — and as of this row Digby
is the closest to occupying it, because (e) is closed honestly and (c) has a real number on the
infrastructure page. Closing (c) properly still needs the owner's call on (b): a cost claim without
a published price is a claim a buyer cannot check.

### Lever-by-lever: what this batch closed, and what it could not

| Lever | State after this batch | Evidence |
|---|---|---|
| (a) named model line | **CLOSED — removed** | owner ruling 2026-10-30 "no names models": `models-pricing.ts` DELETED; `lib/site/pricing.test.ts` pins the absence |
| (b) published CAD tiers | **CLOSED — published at $0** | owner answered `oq_88a750bc`: `PUBLISHED_PRICE_CAD_PER_MONTH = 0` in `lib/site/pricing.ts`; row + FAQ + FAQPage JSON-LD + `Service.offers` all read it; above $0 routes to "Contact us" |
| (c) hard number | **improved, not closed** | `/infrastructure` states the hardware class and location; no cost/throughput figure published |
| (d) bilingual | **improved, not closed** | one reciprocal `hreflang` pair, pinned by `sitemap-hygiene.test.ts`; a real `/fr` tree is a translation project, not an SEO fix |
| (e) named frameworks | **CLOSED** (honestly) | `/compliance` + 6 sector pages + 3 city verticals name the provincial statutes; `content.test.ts` forbids a certification claim |
| (f) trust line | **CLOSED, as a different claim** | `/infrastructure`: storage AND inference location, kept distinct |

### Our own side, measured (not asserted)

| Measure | Before | After this batch | Source |
|---|---|---|---|
| sitemap URLs (source) | 41 | **71** | `app/sitemap.ts` → `publicPaths()` |
| sitemap URLs (served) | 41 | 41 until deploy | live `https://digby.ai/sitemap.xml`, 20:20Z |
| landing pages | 30 | **60** | `SITE_PAGES`: 30 core + 30 generated city pages (measured: `origin/main:content.ts` → 30; HEAD → 60) |
| pages with a full JSON-LD graph | partial — BreadcrumbList + FAQPage only | **all 60** get Organization + WebSite + WebPage + BreadcrumbList, plus Service on offer pages and FAQPage wherever Q&A is visible | `pageGraphLd()` in `lib/site/seo.ts` |
| landing pages with <3 contextual inbound links | 18 | **0** | measured by scratch audit on pre-change trees; now pinned by `seo-schema.test.ts` |
| hreflang pairs | 1 (untested) | 1, **reciprocal + x-default, pinned** | `sitemap-hygiene.test.ts` |

Served sitemap at 20:20Z (verbatim): `41` `<loc>` entries — i.e. this branch is not deployed yet,
and the 71 is a source-level fact until it is. Any row claiming a served count must say which.

### Still absent from the served site (confirmed 20:20Z)

- **No `/pricing`** — nothing at all. Augure's three tiers are a page we cannot answer.
- **One French URL only** (`/ia-souveraine-canada`) — no `/fr` subtree.
- **No named model line** anywhere in the copy.
- **No cost number** on any marketing page.

### Deliberate discipline (binding on all copy — from `frontend/lib/site/content.ts`)

- No "compliant" / "certified" language. Digby holds no PIPEDA / Law 25 / SOC 2 certification.
  Pinned by `content.test.ts` and `seo-schema.test.ts`, and extended this batch to the 30 city pages.
- No model vendor names in *visible* copy (keywords may carry them).
- "Stored in Canada" = AWS Canada Central (Montréal) — never a bare "no data leaves Canada".

This is why lever (f) is written as a different claim above rather than a score: Digby cannot borrow
Augure's "no US parent" line without evidence, and its own site is served from AWS Canada Central.
The honest Digby line is **distributed inference on Canadian hardware we operate** — 7 DGX Sparks,
a B300 in Kamloops (Equinix), a Victoria lab — which is a stronger claim than any of the three,
and `/infrastructure` now makes it.

---

## What this baseline is for

1. This file is the file the watch reads. It lives here, on the branch, and on `main` once merged.
2. Weekly watch `ad86d09f` re-fetches the three competitor sites, diffs the six levers, and appends
   a new dated row **only when a lever actually moves** (otherwise it replies "Nothing new." and stops).
3. The lane folds any movement into the affected pages — pricing row into whatever pricing page the
   owner's decision unlocks, model-naming row into the model component, and so on.

## Open owner decisions this sheet cannot fill

- **Do we publish CAD pricing tiers?** Unlocks lever (b) — currently a flat loss to Augure, and the
  reason lever (c) can only ever be *partial*: a cost claim a buyer cannot check is not a claim.
- **Does Digby get named model variants?** Unlocks lever (a) — the second-flattest row.

**Where the two land when the owner answers** (one source of truth, not 60 pages of copy):
`frontend/lib/site/pricing.ts` exports `PUBLISHED_PRICE_CAD_PER_MONTH` (`null` today);
`pricingOfferDescription()` / `pricingOfferPrice()` feed the `Service.offers` node in `lib/site/seo.ts`,
and `pricingAnswer()` feeds the visible cost FAQ on `/private-ai` and all 30 city pages. Setting that
ONE constant publishes the price everywhere at once — comparison price rows, cost answers, FAQPage
`acceptedAnswer` and the schema offer.

The **named-model** half used to be here (`MODEL_LINE`, `PRICING_TIERS`). It is not any more: the
owner ruled "no names models" on 2026-10-30, so that lever is **resolved by deletion**, and the whole
module was replaced by `pricing.ts`. The price half is now **decided**: the owner answered `oq_88a750bc` on 2026-10-30 ("free to start — a $0 entry point, larger engagements on 'contact us'"), so the constant is `0` and both halves are closed.

## Verified re-check commands (for the next watch)

```
curl -s https://augureai.ca/                                  | grep -iE 'ossington|rosedale|tofino|\$[0-9]+ *\/? *(mo|month)'
curl -s https://discreetlyai.com/                             | grep -iE 'piped|law 25|hipaa|iso 9001|iatf'
curl -s https://micrologic.ca/en/products/private-ai/         | grep -iE '1/3|78%|50%|cirrus'
curl -s https://digby.ai/sitemap.xml                           | grep -c '<loc>'
curl -s https://digby.ai/robots.txt                            | grep -i sitemap
```

---

## Row 2 — 2026-11-05 (competitors fetched 19:37–19:39Z; independently re-verified by this lane at 19:53:43Z)

Sources fetched fresh: `https://augureai.ca/`, `https://augureai.ca/models/rosedale-one`, `https://augureai.ca/fr`,
`https://discreetlyai.com/`, `https://discreetlyai.com/industries.html`, `https://micrologic.ca/en/products/private-ai/`
— all six re-probed **HTTP 200 at 2026-11-05T19:53:43Z**. Digby's own column re-measured from the repo and the live site.

A lever gets a new value here **only if it moved**. Anything unchanged reads "no change vs Row 1".

| Lever | Discreetly | Augure | Micrologic | Digby today |
|---|---|---|---|---|
| (a) Named model / product line | no change vs Row 1 (no named models) | **MOVED** — Rosedale One now has a **full live model page**, not a reference: "Frontier · Reasoning · CA · QC", foundation **Post-trained GLM 5.3**, availability **Pro · Max · API**. Ossington 5 and Tofino 3 unchanged | no change vs Row 1 ("Cirrus Private AI" is a product name, not models) | no change vs Row 1 — **nothing named**; owner ruling 2026-10-30 stands, pinned by `pricing.test.ts` |
| (b) Published CAD pricing tiers | no change vs Row 1 (none public) | **MOVED** — homepage **annual** view: Free $0 · **Pro $200/year** (≈$16.67/mo billed annually) · **Max $800/year** (≈$66.67/mo billed annually) · Enterprise custom, with a Monthly/Annual toggle badged **"2 months free"**. The **French FAQ still states the monthly ladder** — Pro 20 $/mois · Max 80 $/mois — and additionally names **Ultra 200 $/mois** (all-day Augure Code). **Both figures are recorded; neither silently replaces the other** | no change vs Row 1 (none public) | no change vs Row 1 — `PUBLISHED_PRICE_CAD_PER_MONTH = 0` (`lib/site/pricing.ts:67`): $0 published, above $0 = "Contact us", **no ladder**. Augure's tiers stay in their column |
| (c) Hard cost / efficiency claim | no change vs Row 1 (none quantified) | **MOVED — this supersedes Row 1's "time, not dollars"** | no change vs Row 1 ("up to 1/3 the cost" of public cloud per Broadcom on the Silicon Angle podcast · "50% of the cost" · "78% average increase in operating efficiency") | no change vs Row 1 — still no published cost/throughput figure; `/infrastructure` states the hardware class and location |
| (d) Bilingual EN/FR | no change vs Row 1 | no change vs Row 1 (full EN/FR) | no change vs Row 1 (EN/FR toggle) | no change vs Row 1 — one French page + reciprocal hreflang pair; no `/fr` subtree |
| (e) Named regulatory frameworks | **MOVED (delta vs the recorded baseline)** — homepage names **CCPA** ("Built to align with HIPAA, **CCPA**, PIPEDA, and Quebec's Law 25") and `industries.html` names **PHIPA** (Ontario), alongside ISO 9001 · ISO 45001 · IATF 16949 | no material change vs Row 1 (Law 25 · PIPEDA · CPCSC) | **⚠ CONTRADICTED — see "Two contradictions" below.** The watch recorded "no change / no framework named on the product page"; the page as served **does** carry a certifications block | no change vs Row 1 — PIPEDA, Law 25, PHIPA, OSFI E-23 named, **with the explicit no-certification disclaimer**, pinned by `content.test.ts` |
| (f) "No US parent / no data to US" trust line | no change vs Row 1 | no change vs Row 1 (FR FAQ: Canadian storage, Canadian + verified-EU inference under zero-retention, never US providers, no US parent or US investors) | no change vs Row 1 (sovereign control, no lock-in) | no change vs Row 1 — storage in Canada (AWS Canada Central, Montréal) AND inference on Canadian-located GPU hardware, kept distinct on `/infrastructure` |

### Row 2 detail — Augure's (c) in full (verbatim from `augureai.ca/models/rosedale-one`)

- **Price:** `$6` — "Price · CAD per 1M output tokens", tagged **Developer API** (pay-per-use, daily account spend cap, OpenAI-compatible).
- **Benchmarks** — "Measured, not promised." Reproduced verbatim **with their n and CI**, because a number without them is not checkable:

| Benchmark | Score | n | 95% CI |
|---|---|---|---|
| Coding · HumanEval | 98.2 | n = 164 | 94.8–99.4 |
| Math · AIME 2025 | 86.7 | n = 30 | 70.3–94.7 |
| Grounded answers · Québec sources | 100.0 | n = 60 | 94.0–100.0 |

- **Lineage, in their words:** "Rosedale One starts from GLM 5.3, a frontier-class, openly released foundation model. What makes it an Augure model is the post-training we do on top: standard Quebec French, Canadian legal and civic context, censorship and refusal audits… Because the weights are open, nothing round-trips to the model's maker. We serve GLM 5.3 ourselves on infrastructure under contract to Augure."
- Methodology stated: "October 2026, one harness for every model."

### Two contradictions between the watch's notes and the pages as served

The watch's Row-2 notes and this lane's own fetch agree on Augure (every figure reproduced above) and on
Discreetly's framework list. They **disagree** in two places, and per the sheet's method both sides are
recorded rather than one being overwritten.

**1. Micrologic (e) — "no framework named on the product page" does not survive a read of the page.**
The product page carries a block headed **"Our certifications"**, verbatim:

> "Micrologic's Cirrus cloud and our professional services hold **ISO 27001:2013, ISO 27017:2015 and ISO 27018:2019** certifications… **SOC 2 Type 2** — as a SOC 2 certified company, Micrologic is audited annually… **STAR Level 1**: IT security and privacy… **HIPAA** … this validation confirms the governance rules in place within our sovereign cloud for the legal use and disclosure of protected health information."

So the honest (e) value for Micrologic is **"names security certifications (ISO 27001/27017/27018, SOC 2 Type 2,
STAR Level 1) and HIPAA — but names no privacy statute"**: `PIPEDA`, `Law 25`, `PHIPA`, `CCPA` and `GDPR` each
return **0 hits** on that page. That is a narrower and more useful claim than "names nothing", and it changes the
row's shape: Row 1's "Micrologic publishes numbers but names no framework" is **half wrong** — it names
certifications, just not privacy statutes.

**2. Discreetly's framework language is hedged, and the row should say so.**
The homepage sentence is "**Built to align with** HIPAA, CCPA, PIPEDA, and Quebec's Law 25 **depending on where
your data needs to stay**" — an alignment claim conditioned on region, not "compliant"/"certified". The FAQ is
similar: "built to meet data sovereignty and residency requirements wherever they apply". Digby's own copy
discipline forbids the word "compliant" for *us*; describing *them* as compliant when their page says
"built to align" would be putting a word in their mouth. Row 2 therefore records the hedge.

Two smaller corrections: the **"2 months free"** badge is attached to the Monthly/Annual toggle (not stated in
the watch note), and **Ultra appears in the French FAQ but not in the English homepage's visible annual cards**
(the string `Ultra` occurs twice in the English page source, both inside the serialised RSC payload, and zero
times in its rendered text). Both figures are real; the languages simply disagree, which is itself the finding.

### The finding that changed — Row 1's "empty slot" is no longer empty

Row 1's headline was that **no competitor owns both halves of the same row**: Discreetly names frameworks but
publishes no number; Micrologic publishes numbers but names no framework; Augure published pricing but only a
*time* claim. **Row 2 closes that gap in Augure's favour.** Augure now names regulatory frameworks (Law 25 ·
PIPEDA · CPCSC, unchanged since Row 1) **and** publishes a checkable dollar figure (`$6 CAD per 1M output
tokens`, Developer API) **and** publishes benchmark scores with sample sizes and confidence intervals.

That is a material competitive change, and the honest consequence is stated here rather than softened: it is no
longer true that Digby is "the closest to occupying" the framework-named-and-number-backed slot. **Augure
occupies it today.** What Digby still holds that Augure does not is the *infrastructure* number (hardware class
and both locations) plus open weights and a self-hosting path — not a model benchmark and not a per-token price.

Two caveats that keep the comparison fair, and both are on the record above: Augure's benchmarks measure model
quality on three named tasks (they are not throughput or latency), and their two pricing surfaces **disagree by
language** (annual cards in English; a monthly ladder plus Ultra in the French FAQ). A buyer comparing us should
be told that Augure has the stronger published-number position now, because they will find it anyway.

### Our own side, measured this row (not asserted)

| Measure | Row 1 | This row | Source |
|---|---|---|---|
| served sitemap `<loc>` count | 41 | **71** | `curl -s https://digby.ai/sitemap.xml \| grep -c '<loc>'` → `71`, at 19:53:43Z — Row 1's "propagates on deploy" caveat is now **closed** |
| robots sitemap line | present | present | `curl -s https://digby.ai/robots.txt` → `Sitemap: https://digby.ai/sitemap.xml` |
| published CAD price | 0 | **0** | `frontend/lib/site/pricing.ts:67` |

### Deliberate discipline (unchanged, and it bound this fold)

- No "compliant" / "certified" language about Digby. Pinned by `content.test.ts` / `seo-schema.test.ts`.
- **No model vendor names in visible copy** — this is why Row 2's model lineage is described on the page as
  "post-trained from an openly released frontier model" and the vendor token appears **only in this sheet and in
  page keywords**. `content.test.ts` matches the vendor regex against everything except `keywords`.
- "Stored in Canada" = AWS Canada Central (Montréal), never a bare "no data leaves Canada".
- Digby's own pricing unchanged: $0 entry, "Contact us" above it, **no tier ladder** (owner ruling `oq_88a750bc`).
  Augure's tiers live in the competitor column only.

### Verified re-check commands (Row 2 superset — use these next time)

```
# Augure — the three MOVED levers, (a)(b)(c)
curl -s https://augureai.ca/models/rosedale-one | grep -oE '(Post-trained GLM 5\.3|\$6|HumanEval|AIME 2025|n = [0-9]+ · 95% CI [0-9.]+–[0-9.]+|Pro · Max · API)'
curl -s https://augureai.ca/                  | grep -oE '(\$[0-9]+</span><span[^>]*>/year|2 months free|Free is \$0)'
curl -s https://augureai.ca/fr                | grep -oE '(Pro coûte 20 ?\$/mois.*Ultra.*200 ?\$/mois)'
# Discreetly (e) — the hedge is the point: capture the sentence, not a verdict word
curl -s https://discreetlyai.com/             | grep -oE 'Built to align with[^<]{0,120}'
curl -s https://discreetlyai.com/industries.html | grep -ciE 'phipa'
# Micrologic (e) — the row Row 1 got half wrong
curl -s https://micrologic.ca/en/products/private-ai/ | grep -oE '(ISO 2701[78][^<]{0,12}|SOC 2 Type 2|STAR Level 1)'
curl -s https://micrologic.ca/en/products/private-ai/ | grep -ciE 'piped|law 25|phipa'   # expect 0
# Digby's own side
curl -s https://digby.ai/sitemap.xml           | grep -c '<loc>'
```
