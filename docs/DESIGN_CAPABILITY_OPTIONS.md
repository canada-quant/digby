# Design Capabilities for Generated Documents — Options Menu

> **Status: consultation delivered, engine unchanged.** Ticket 974f2406 asked for
> OPTIONS for making generated PDFs/documents "less boring, professionally
> designed" — this doc is the options menu the owner asked for. It is NOT an
> implementation: `create_document` keeps its current, deliberately-minimal
> output until the owner picks a direction. This doc exists so a pick becomes a
> one-line follow-up instead of a research project.
>
> Filed: 2026-09-25 · grounded in `backend/src/modules/crossmodel/document-generator.ts`
> and `backend/package.json` as verified on that date.

## Why current output looks "AI-generated and boring"

The generator (`document-generator.ts`) is intentionally bare. Today it supports:

| Format | What you get today | Why it's plain |
|---|---|---|
| **PDF** | US Letter (612×792), 50pt margins, Helvetica 11pt body, 16pt bold title, ~95 chars/line, black text | pdf-lib with **standard fonts only** — no embedded fonts, no color, no images, no headers/footers, no page numbers |
| **DOCX** | H1 title + default-styled body paragraphs | `docx@9` used for structure only — no styling API surface wired |
| **XLSX** | Plain cells, numeric-cast, ≤20 sheets × 50k rows | `exceljs@4.4` (MIT) — no cell styles, no column widths, no freeze panes (SheetJS `xlsx@0.18.5` retired 2026-10-13, ticket 3be57df0: unmaintained on npm, 2 HIGH advisories OSV flags on every version) |
| **txt / md / csv / json** | Verbatim text | n/a — no styling applies |

Every hard cap, from the 500k-char content cap and 15MB buffer cap down to the
20-second PDF form-parse timeout, exists to keep a runaway generation from
stalling the agent run — that posture should not change as styling grows.

## The options

Five directions, ordered small→large. Each names what ships, what it costs, and
the honest trade-off.

---

### Option A — Typographic polish (PDF) · smallest

**Ship:** a small set of layout constants as a new optional `design` param on
`create_document`/`update_document`, applying to PDFs only:

- `theme: 'classic' | 'modern' | 'report'` — three pre-tuned layouts: font pair
  (Helvetica/Times/Courier standard-14 permutations), title size, rule under the
  title, margin width, body size/leading.
- `accent: '#RRGGBB'` — one accent color applied to the title/rule (body stays
  black for readability).
- `titlePage: boolean` — vertically-centered title page with title + date.
- `footer: 'page' | 'none'` — `Page N of M` centered in the footer margin.

**Cost:** small — pdf-lib can do all of this today with standard fonts; it's
layout constants + a footer pass after pagination. No new dependencies.

**Trade-off:** biggest visual lift per line of code, but still Helvetica-family
only. It makes PDFs look "typeset" rather than "printed from notepad", but
cannot escape the standard-font look entirely.

**Risk:** low. All within pdf-lib's WinAnsi-safe `drawText` path already used.

---

### Option B — Markdown-rendered PDF body · small

**Ship:** teach the PDF path to honor the markdown the model naturally emits:
`##`→H2, `###`→H3, `- ` bullets, `**bold**`, `` `code` `` and code blocks, simple
tables, horizontal rules. (The DOCX path already splits on blank lines; this
brings PDF to parity with what the model writes anyway.)

**Cost:** moderate — a small markdown-subset parser (sized between the existing
`wrapLine` and pdf-lib's layout engine). Keep it to a strict subset; do NOT
pull in a full markdown engine for the agent path.

**Cost of NOT doing it:** today a model that writes markdown into a `pdf`
`content` arg gets literal `##` hashes in the output — a direct driver of the
"AI-generated looking" complaint.

**Trade-off:** compounding with Option A, this is where "boring" mostly dies:
headings hierarchy + bold + bullets + a title rule. Tables/code keep a simple
boxed style.

---

### Option C — DOCX styling layer · small

**Ship:** wire the `docx@9` styling surface that's already installed but unused:
theme fonts/sizes, styled H2/H3 (the model's `##`/`###` markdown maps onto
them), bullet/numbered lists, bold/italic runs, optional header (title) and
footer (page numbers), and table borders for tabular content. Optional
`design` param mirrors Option A's shape.

**Cost:** small — the library already supports all of it; it's wiring existing
API surface into the generator, plus markdown-subset parsing shared with Option B.

**Trade-off:** none material. DOCX files open in Word/Google Docs where users
can restyle further; a professional default makes the generated artifact match.

---

### Option D — Images, covers & charts in PDFs/DOCX · medium

**Ship:** the two things that most make a document feel designed:

1. **Cover images / inline images** — `generate_image` output (and image
   attachments) embedded as cover art or inline figures in PDF/DOCX. pdf-lib
   embeds PNG/JPG natively (`embedPng`/`embedJpg`); `docx@9` has `ImageRun`.
   A `cover: { imageFileId | uploadId }` param plus inline-figure syntax.
2. **Charts** — data → chart image → embedded. Either (a) generate SVG server-side
   and rasterize, or (b) add a chart library. Both need a rasterization step:
   **no headless-browser dep exists today** (no playwright/puppeteer in
   `backend/package.json`), and neither does `sharp` or `chart.js` — so this
   option means taking a new dependency (or a tiny SVG rasterizer).

**Cost:** medium — new deps + bytes-on-disk accounting (image bytes count
against the 15MB buffer cap and the 200MB per-user storage quota) + explicit
user consent for generated-image spend when charts/images are requested.

**Trade-off:** this is the highest-impact option for the "fancy" ask, but it's
also the first option that changes the dependency tree and needs a quota/cost
review pass (the 2026-09-24 image-storage quota work is the template to follow).

---

### Option E — HTML→PDF engine (designer-grade) · large

**Ship:** a real HTML/CSS→PDF renderer (Playwright print-to-PDF or equivalent),
so documents can carry any CSS design — brand colors, columns, full-bleed
covers, web fonts, print CSS. Exposed as a new `design: 'html'` mode or a
`template: '…'` param; the agent writes HTML+CSS, the renderer prints.

**Cost:** large — a headless-browser runtime in the container (Playwright +
Chromium ≈ hundreds of MB), a per-render timeout, and careful sandboxing
(browser in the agent path = a new attack surface; the sandbox egress guard
afdbe811f is the model to follow). Also a rewrite of the size/timeout posture:
print-to-PDF can hang in ways pdf-lib never does.

**Trade-off:** unlimited design ceiling, but it's a platform-level decision —
new runtime, new security review, new dep tree. Only worth it if Option A+B+C+D
together still leave the output short of "professionally designed".

---

## What you get today without any engine work (free wins)

Worth stating because they need zero code:

1. **Google Workspace route** — `docs_create_document` /
   `sheets_create_spreadsheet` / `slides_create_presentation` already produce
   native Google files the owner can restyle in-place, and Google's own
   defaults look professional. For anything going to a human editor, this is
   often the better artifact.
2. **Canvas types** — `create_canvas` with `type: 'html'` or `'mermaid'` gives
   designed, viewable-in-app artifacts without any PDF engine at all.
3. **Image generation** — `generate_image` (shipped 2026-09-24) covers covers/hero art,
   diagrams-as-art, and logos; combined with manual insertion in Google Docs it
   covers a surprising amount of the "fancy" ask.
4. **Templates by convention** — the agent can be taught (doctrine only, no
   code) to always open PDFs with a title page structure and closing page in
   its `content` string, which Option A would then typeset properly.

## Recommendation

**B → C → A → D → E** in that order, as separate small PRs. B and C kill the
most "AI-generated" tells (literal markdown hashes in PDFs; unstyled DOCX) for
the least code; A adds the typographic identity layer; D adds the visual
richness; E only if the ceiling still matters after A–D ship.

Each option is independently shippable, testable (generator unit tests +
golden-file fixtures), and reversible (a `design` param that defaults to
`undefined` = today's output, so nothing changes until asked for).
