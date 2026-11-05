# Document Read/Write/Edit Tools — Design Note (P1)

> **Ticket:** feedback `0b18dc53` (owner ticket `9dac6576` — "Digby, Read/Write/Edit my
> documents: PDF, DOCX, XLSX, CSV, TXT, including ones containing pictures; fill in this
> PDF form; create a spreadsheet of this data; save results to my Files").
> **Phase:** P1 = research + design only. This document is the entire deliverable — no
> runtime code changes. P2/P3 implement.
> **Date:** 2026-08-24 · **Branch:** `digby/nightly-20260824-doc-tools`

> ⚠ STALE (2026-10-13, ticket 3be57df0): the dependency versions in this archived
> design note are historical. `multer` is now `^2.4.0` (security bump, was ^2.0.2)
> and SheetJS `xlsx` was REPLACED by `exceljs` ^4.4.0 (was the unmaintained
> registry `^0.18.5` — GHSA-4r6h-8v6p-xvw6 / GHSA-5pgg-2g8v-p4x9 have no registry
> fix and OSV flags every SheetJS version, vendor CDN included). The READ-path
> inventory and line references remain accurate for orientation; re-check
> `backend/package.json` for current versions.

---

## 1. Current READ inventory (what exists today)

READ is fully built for **ingestion into chat context and RAG** — every format the ticket
names is already *read*. What does not exist is any **write/edit** capability and any
**binary persistence** (see §3 gap analysis).

### 1.1 Chat upload pipeline (the primary READ path)

`POST /api/crossmodel/upload` → `processUpload` —
`backend/src/modules/crossmodel/upload.controller.ts:230`
(mounted at `backend/src/modules/crossmodel/crossmodel-open.routes.ts:158`,
`optionalAuthenticate`; rate-limited in `backend/src/app.ts:185-198`).

Accepts JSON-base64 or multipart, 50 MB cap (`upload.controller.ts:50-55`), MIME allowlist
+ extension fallback (`upload.controller.ts:33-59`, `detectMimeByExtension` at `:188`):

| Format | Extractor | Anchor |
|---|---|---|
| PDF | `extractPdfText(buffer, filename)` — tiered: **pdf-parse** baseline → **Gemini vision OCR** for scanned/layout-sensitive; result sliced to 50 k chars; raw base64 ALSO kept for native-vision models (OpenAI/Gemini/Grok) | `upload.controller.ts:274-306`, `backend/src/modules/crossmodel/pdf-extract.ts:126` (`ocrPdfWithVision` at `:88`, pdf-parse class API at `:62-65`) |
| DOCX | **mammoth** `extractRawText`, 50 k slice | `upload.controller.ts:307-317` |
| XLSX / XLS | **xlsx** (SheetJS) `read` → per-sheet `sheet_to_csv` (tab-separated), 20 k slice | `upload.controller.ts:321-344` |
| TXT / CSV / JSON / XML / MD | native `buffer.toString('utf-8')`, 50 k slice | `upload.controller.ts:346-365` |
| Images (jpeg/png/webp/gif/heic/heif) | no text extraction — base64 passed to vision-capable models | `upload.controller.ts:267-271` |

The staged `Attachment` lives in **Redis with a 15-min TTL** (key `cm:upload:<uuid>`,
`saveAttachment` at `upload.controller.ts:106-123`; `/tmp` same-instance fallback) and is
merged for the model loop by `combineAttachments` (`upload.controller.ts:144-180`).

For authenticated users the upload is **auto-ingested into the Files store**: a
`ProjectDocument` row (`source: 'chat_upload'`) is created and `processDocument` runs
fire-and-forget (`upload.controller.ts:380-411`).

### 1.2 Knowledge-base ingestion (RAG)

`backend/src/modules/crossmodel/ingestion.service.ts`:
- `extractTextFromBuffer` (`:68-95`) — PDF via `extractPdfText` (`:78`), DOCX via mammoth
  (`:85`), everything else utf-8 (`:90`).
- `processDocument` — chunks (RecursiveCharacterTextSplitter), Kimi-contextualizes,
  embeds (DashScope text-embedding-v4, 1536-dim pgvector), stores `ProjectChunk` rows,
  flips status → `ready`. Concurrency-capped at 3 (`:35`).

Project knowledge-base upload endpoint: `POST /api/crossmodel/projects/:id/documents` →
`uploadDocumentToProject`, `backend/src/modules/crossmodel/documents.controller.ts:118-180`
(routes at `documents.routes.ts:11-15`; 30 MB cap, PDF/DOCX/TXT/MD + images — images are
**vision-described by GPT-5.6-luna** for RAG at `documents.controller.ts:42-100`).

### 1.3 Connector-side READ (already agent-reachable)

- **Google Drive files:** `backend/src/modules/crossmodel/google/google-mcp.ts:284-302` —
  PDF through the same pdf-parse + Gemini OCR path, DOCX through mammoth.
- **Gmail attachments:** `gmail_get_attachment` — "Text files return inline text;
  PDF/DOCX return extracted text" (`backend/src/modules/crossmodel/coding/integration-tool-schema.ts:77`).

### 1.4 Installed document dependencies (`backend/package.json`)

| Package | Version | License | Role today | Write-capable? |
|---|---|---|---|---|
| `pdf-parse` | ^2.4.5 (`:51`) | MIT | PDF text baseline | **No** (read-only) |
| `mammoth` | ^1.11.0 (`:49`) | BSD-2-Clause | DOCX → raw text | **No** (read-only) |
| `xlsx` (SheetJS CE) | ^0.18.5 (`:57`) | Apache-2.0 | XLSX/XLS → CSV text | **Yes** (`XLSX.write` — unused today) |

**Not installed:** `pdf-lib`, `docx`, `exceljs`. (multer ^2.0.2 handles upload parsing;
no file-conversion or rendering deps exist.)

---

## 2. User Files storage (where results must land)

### 2.1 The store: `ProjectDocument`

`backend/prisma/schema.prisma:346-367` — one row per user file:

```prisma
model ProjectDocument {
  id         String   @id @default(uuid())
  projectId  String?  // null = ungrouped (appears in global Files folder)
  userId     String
  name       String   // display name
  mimeType   String   // pdf | docx | txt | url | pasted
  sourceUrl  String?
  source     String   @default("knowledge") // "knowledge" | "chat_upload"
  charCount  Int      @default(0)
  chunkCount Int      @default(0)
  status     String   @default("processing") // processing | ready | error
  ...
}
```

Embedded chunks live in `ProjectChunk` (`schema.prisma:370-387`, pgvector).
Adjacent surface: `CanvasDocument` (`schema.prisma:390-409`) — AI-generated in-chat
artifacts (document/code/html/mermaid/table), already listed on the Files page.

### 2.2 The exact Files API surface (what an agent-facing "save to Files" plugs into)

| Operation | Route | Handler | Anchor |
|---|---|---|---|
| List all user files | `GET /api/crossmodel/files` | `listAllFiles` — per-user `projectDocument.findMany` incl. project + chunk count | `backend/src/modules/crossmodel/sharing.routes.ts:15` → `sharing.controller.ts:206-238` |
| List project files | `GET /api/crossmodel/projects/:id` | documents block | `projects.controller.ts:137-151` |
| Upload to project | `POST /api/crossmodel/projects/:id/documents` | `uploadDocumentToProject` | `documents.routes.ts:11-15` |
| Poll status | `GET /api/crossmodel/documents/:docId/status` | `getDocumentStatus` (owner-scoped, IDOR-fixed) | `documents.routes.ts:21` |
| Delete | `DELETE /api/crossmodel/documents/:docId` | `deleteDocument` (owner-only) | `documents.routes.ts:24` |
| Frontend | `/crossmodel/files` page → `filesApi.listAll()` | | `frontend/app/crossmodel/files/page.tsx:30`, `frontend/lib/api/crossmodel.ts:466-471` |

### 2.3 ⚠ The gap that shapes P2: **no binary is stored anywhere**

`ProjectDocument` keeps **only extracted-text metadata** — the original bytes are
discarded after extraction (chat uploads keep base64 solely in the 15-min Redis staging
key). There is **no download/serve endpoint**: no `res.download`, no
`Content-Disposition` anywhere in the crossmodel module (verified by grep). You cannot
"save a filled PDF to Files" today because Files has nowhere to put bytes.

**P2 must therefore add binary persistence first** (§5.1), then the write tools are a
thin layer on top. Saving to user Files = `prisma.projectDocument.create` (+ new binary
fields) exactly as `upload.controller.ts:389-399` and `documents.controller.ts:145-156`
already do, plus a new authenticated download route.

---

## 3. Agent tool registration surface (where the new tools go)

The plain-chat agent's callable tools are **platform tools**; registration is
three mechanical steps, all in `backend/src/modules/crossmodel/platform/`:

1. **Name lists** — `platform-tool-names.ts`: add to `PLATFORM_READ_TOOLS` (`:16-29`)
   and/or `PLATFORM_MUTATING_TOOLS` (`:32-56`) → they flow into `PLATFORM_TOOL_NAMES`
   (`:65`). **No other wiring is needed for chat exposure:**
   `CHAT_PROFILE_PLATFORM_TOOLS = [...PLATFORM_TOOL_NAMES]`
   (`backend/src/modules/crossmodel/coding/agent-profiles.ts:60`) → `CHAT_ORCH_TOOLS`
   (`coding/agent.ts:74-79`) — the fleet test pins this "no extra wiring" property
   (`platform-tools.fleet.test.ts:224-226`).
2. **Schema** — append OpenAI-format definitions to `PLATFORM_TOOL_SCHEMA`
   (`platform-tools.ts:70`).
3. **Dispatch** — add `case`s to the `switch (name)` in `executePlatformTool(ctx, name,
   args)` (`platform-tools.ts:1009`, switch at `:1039`). `ToolContext` carries the
   authenticated `userId` — per-user scoping comes from there, never from args.

Gating knobs that already exist and should be reused:
- **Confirmation staging** for consequential tools: `CONSEQUENTIAL_PLATFORM_TOOLS`
  (`platform-tools.ts:760`) — first call returns `needsConfirmation` + `confirmationId`,
  re-call from a NEW user turn executes (staged at `:768`/`:818`, consumed at `:1013-1036`).
- **Ask-only destructive** list: `PLATFORM_ASK_ONLY_TOOLS` (`platform-tool-names.ts:60`).
- **Test pins to update:** `EXPECTED_TOOLS` in `platform-tools.test.ts:208-209` and the
  fleet schema-pins in `platform-tools.fleet.test.ts:228+` (mechanical, expected).

(Separate surfaces, NOT for this work: connector tools in
`coding/integration-tool-schema.ts`; model-loop web tools in `tool-executor.ts:36` —
`TOOL_DEFINITIONS` consumed by moonshot `:431` / glm `:327` / deepseek `:528`.)

---

## 4. WRITE/EDIT dependency recommendation

| Format | WRITE | EDIT existing | Rationale / license |
|---|---|---|---|
| **PDF** (new + form fill) | **pdf-lib** *(new dep)* | **pdf-lib** — `PDFDocument.load` → `getForm().getTextField(name).setText()`; page copy/merge | The only mature pure-JS lib that both creates PDFs and fills AcroForm fields; no native code (runs on node:20-alpine/musl — unlike pdfkit's fontkit native deps this is pure TS). License: **MIT**. |
| **DOCX** (new) | **docx** *(new dep)* | ⚠ gap — see below | `docx` (npm) generates OOXML documents (paragraphs/tables/images) with a declarative API and `Packer.toBuffer`. License: **MIT**. |
| **DOCX** (edit in place) | — | **pizzip + docxtemplater** *(new deps)* or raw `jszip` + XML string ops — **decide at P3 start** | `docx` cannot modify an existing document's paragraphs; in-place edit = unzip `.docx` → patch `word/document.xml` → rezip. `docxtemplater` covers the common "fill template placeholders" case declaratively. Licenses: **MIT** (pizzip/docxtemplater/jszip). |
| **XLSX** (new + edit) | **xlsx (SheetJS CE) — already installed** | same, read-modify-write (`XLSX.read` → mutate → `XLSX.write`) | Ticket prefers what's installed; CE covers cell values/formulas/sheets. Known limit: **round-trip loses styling** (CE doesn't preserve cell styles) — if styled output becomes a requirement, add `exceljs` (MIT) then. |
| **CSV / TXT / MD** | native (`Buffer.from(string)`) | native | No dep; just generate/replace text. |

New runtime deps for P2: `pdf-lib`, `docx` (+ `@types/` none needed — both ship types).
P3 adds pizzip/docxtemplater only if in-place DOCX edit is scoped in. All MIT/Apache —
compatible with the repo's MIT license; no copyleft, no native builds (musl-safe per the
learned node:20-alpine constraint).

---

## 5. Tool design

### 5.1 Prerequisite (P2 foundation): binary persistence for Files

- **Schema:** add to `ProjectDocument`: `storageKey String?` (S3 object key, uuid-based),
  `byteSize Int?`, `supersedesId String?` (edit lineage, P3). `source` gains value
  `'agent_generated'`. Hand-written migration via `prisma migrate diff` (container has no
  DB; prod runs `migrate deploy` — per AGENTS.md).
- **Storage:** **S3, not RDS bytea.** Rationale: prod already runs S3 (nightly backup
  offsite), keeps 25 MB binaries out of the RDS backup/restore path, and enables
  presigned downloads without streaming through the app. Bucket + prefix per env
  (e.g. `s3://<bucket>/user-files/<userId>/<uuid>`); IAM for the ca-central-1 fleet to be
  confirmed during P2 (open question §7).
- **Download:** new authenticated route `GET /api/crossmodel/documents/:docId/download` →
  owner-or-project-editor check (reuse the `canEditProject` pattern,
  `documents.controller.ts:106-115`) → 302 to a short-lived presigned URL, or stream
  through the app with `Content-Disposition: attachment; filename="<sanitized>"` for
  private-bucket simplicity. Legacy rows (`storageKey NULL`) → 404 "original binary not
  retained" (honest failure, no fake-empty file).
- **Ingestion parity:** after storing bytes, extract text with the §1 extractors and run
  the existing `processDocument` so generated files are immediately RAG-searchable —
  identical to the chat-upload auto-ingest (`upload.controller.ts:380-411`) but with
  `status: 'ready'` semantics preserved on failure (binary persists even if embedding fails).

### 5.2 Proposed agent tools

Three tools (names follow the platform-tool snake_case convention):

**`document_create`** — *mutating, NOT consequential* (creates a brand-new file; mirrors
`create_chat`/`create_project` risk class).

| Param | Type | Notes |
|---|---|---|
| `filename` | string | Display name only — **never a filesystem/S3 path**. Sanitized: strip `/ \ ..` + control chars, enforce extension matches `format`. |
| `format` | `'pdf' \| 'docx' \| 'xlsx' \| 'csv' \| 'txt' \| 'md'` | Server derives MIME from this, never from caller input. |
| `content` | string | For txt/md/csv: the literal body. For pdf: markdown-ish source laid out by pdf-lib (headings/paragraphs/table blocks). |
| `sheets` | array? | xlsx: `[{ name, rows: string[][] }]` → `aoa_to_sheet`. |
| `paragraphs` | array? | docx: `[{ text, style? }]` (P2 minimal; richer DSL later). |
| `projectId` | string? | Target project; omit → ungrouped (global Files folder), same semantics as `ProjectDocument.projectId` null. |

Returns: `Created "<name>" (<size>) in Files [id …] — download: <url>. Tell the user it's
in their Files tab.` The tool result text must include the id + link so the model can
surface it (platform tools return strings to the model).

**`document_edit`** — *mutating AND consequential* (joins
`CONSEQUENTIAL_PLATFORM_TOOLS`): it modifies an existing user file, so the first call
returns a confirmation summary ("Fill 6 form fields in form.pdf → saves as
form-filled.pdf") for explicit user approval in a new turn.

| Param | Type | Notes |
|---|---|---|
| `documentId` | string | Resolved owner-scoped: `findFirst({ id, userId: ctx.userId })` (or project-editor via `canEditProject`) — IDOR-safe like `getDocumentStatus` (`documents.controller.ts:264-276`). |
| `ops` | array (discriminated by `type`) | pdf: `{type:'fill_form', fields:[{name,value}]}`, `{type:'flatten'}` · xlsx: `{type:'set_cells', sheet, cells:[{cell,value}]}`, `{type:'add_sheet', name, rows}` · docx: `{type:'replace_text', find, replace}[]` (paragraph-scope) · csv/txt/md: `{type:'replace'|'append'|'prepend', …}`. Unknown/unsupported op for the format → 400-style tool error listing supported ops (apply-or-reject — never silently drop, per the learned todo_update lesson). |
| `outputName` | string? | Default `<name>-edited.<ext>`. P3 saves as a NEW row with `supersedesId` → original kept as undo. |

**`document_read`** — *read-only* (`PLATFORM_READ_TOOLS`): `{ documentId, offset?,
limit? }` → extracts text **from the stored binary** (S3 fetch → §1 extractors) with
paging (defaults mirroring today's 50 k/20 k slices), falling back to stored
chunks/extracted metadata for legacy no-binary rows. Gives the agent faithful re-reads of
Files content without re-upload.

(`document_list` deliberately omitted: `get_project` + the Files API already enumerate;
can be added later if chat UX demands it.)

### 5.3 Output flow into user Files

```
agent calls document_create/edit
  → executePlatformTool case (platform-tools.ts:1039)
  → generate buffer (pdf-lib / docx / xlsx / native)         [CPU-bound, size-capped]
  → magic-byte sniff of generated buffer (§5.4)
  → S3 put  s3://…/user-files/<userId>/<uuid>                 [new]
  → prisma.projectDocument.create({ source:'agent_generated',
      storageKey, byteSize, mimeType (server-derived),
      charCount from extracted text, status:'processing' })   [same call shape as
                                                               upload.controller.ts:389]
  → fire-and-forget processDocument(doc.id, extractedText)    [RAG parity]
  → return id + download URL string to the model
  → frontend Files page: new Download button for rows with storageKey
```

### 5.4 Limits & safety constraints

- **Size:** generated output ≤ **25 MB** (under the 50 MB upload cap,
  `upload.controller.ts:52`); tool input caps: `content` ≤ 1 M chars, xlsx ≤ 10 k
  rows/sheet × 20 sheets, pdf ≤ 200 pages, `ops` ≤ 100/call. Over-cap → explicit tool
  error (never truncate silently).
- **No path traversal:** `filename` is a display string; S3 keys are server-generated
  uuids under `user-files/<userId>/`; no user input ever touches `fs` paths.
- **Per-user scoping:** all lookups/writes keyed by `ctx.userId` (ToolContext);
  project-targeted writes check `canEditProject`. Child (Digby Kids) tokens: document
  tools must respect the `rejectChild` posture used by documents routes
  (`documents.routes.ts:8`) — enforce at execution (open question §7).
- **MIME validation:** MIME derived from the `format` param server-side; generated
  buffers magic-byte-checked (`%PDF-`, `PK\x03\x04` for OOXML zip) before S3 put.
- **Confirmation:** `document_edit` consequential-gated (§5.2); `document_create` not;
  nothing here is ask-only destructive (`delete_chat` class).
- **Frontend XSS:** download route sets `Content-Disposition: attachment` with a
  sanitized filename; Files page continues rendering names via React-escaped text only.
- **Rate limiting:** tool execution rides existing platform-tool gating; binary
  generation is CPU-bound in the API process — if abuse appears, move generation to the
  worker (decision deferred; 25 MB cap bounds it).

---

## 6. Phased implementation plan

### P2 — Write NEW documents to Files (next session)

1. Prisma migration: `storageKey`, `byteSize`, `supersedesId` on `project_documents`
   (hand-written diff; prod `migrate deploy`).
2. S3 client + put/presign helpers (`backend/src/modules/crossmodel/file-storage.service.ts`).
3. `GET /api/crossmodel/documents/:docId/download` (owner/project-editor gate; 404 for
   legacy no-binary rows).
4. `document_create` platform tool: txt/md/csv native, xlsx via installed SheetJS, pdf
   via new `pdf-lib`, docx via new `docx`; RAG auto-ingest parity.
5. Files page: download button + "Created by Digby" badge for `source='agent_generated'`.
6. Tests: tool schema pins (`platform-tools.test.ts` EXPECTED_TOOLS, fleet pins),
   per-format generation round-trip (create → re-extract → assert text), scoping/IDOR
   tests, magic-byte + size-cap rejections.

**P2 acceptance criteria**
- From plain chat: "Create a spreadsheet of this data" / "make a PDF summary" produces a
  real file visible at `/crossmodel/files` with a working download, on both app
  instances (no per-box state).
- Downloaded file opens in native apps (Excel/Word/Preview) and contains the requested
  data; re-uploading it round-trips through existing READ extraction.
- Files are RAG-searchable within seconds (status `ready`), same as chat uploads.
- A second authenticated user cannot read/download/scope into the first user's files
  (IDOR tests green); child tokens refused.
- `npx tsc --noEmit`, lint, jest green; migration applies cleanly via `migrate diff` review.

### P3 — Edit EXISTING documents

1. Binary retention for uploads (store originals on upload so there's something to edit)
   + `supersedesId` version chain.
2. `document_edit`: PDF AcroForm fill + flatten (pdf-lib), XLSX cell/sheet ops (SheetJS
   round-trip), DOCX `replace_text` via pizzip/docxtemplater (decision at start),
   CSV/TXT/MD replace/append.
3. `document_read` (paged re-extract from stored binary).
4. Confirmation summaries rendering exact field/cell diffs pre-approval.

**P3 acceptance criteria**
- "Fill in this PDF form for me" on an uploaded AcroForm PDF produces a filled,
  downloadable PDF with every requested field set (verified by re-extraction/assert in
  tests); XFA/signed PDFs fail with an explicit unsupported-message, not corruption.
- "Change cell B2 to X" / "replace every 'foo' with 'bar' in my docx" saves a new
  version; the original remains downloadable via the `supersedesId` chain.
- Every edit requires and records user confirmation (consequential gate) — an unattended
  machine run cannot silently mutate user files.
- Known fidelity limit documented to the user when hit: SheetJS CE round-trip drops
  existing cell styling (exceljs upgrade path noted).

### P4 (future, related lanes — not this ticket)

- Vision-for-documents: images embedded in PDFs/DOCX are invisible to today's text
  extractors (mammoth `extractRawText` drops them; pdf-parse ignores image XObjects).
  Related in-repo vision lanes: `ocrPdfWithVision` (`pdf-extract.ts:88`),
  `describeImageForKnowledgeBase` (`documents.controller.ts:42`), chat image
  understanding (`chat-agent/chat-context.ts:385`), and the screenshot-vision work
  referenced as commit `e87aee19` in the ticket lane (hash not in this repo's history —
  likely the browser-agent/dev-container lane; nearest in-repo ancestors: `8a4ae057`
  staging chat images onto session containers, `efd85e99` vision pre-gate). P4 = extract
  embedded images → vision-describe → include in extraction, and image embedding into
  generated PDF/DOCX (pdf-lib `embedPng`, docx `ImageRun`).

---

## 7. Risks / open questions

1. **S3 vs RDS bytea** (recommended S3) — confirm the prod bucket, IAM permissions for
   the ca-central-1 fleet (A/B instances), and whether backups should include the
   user-files prefix. Fallback: `bytea` column keeps everything in RDS (simpler IAM,
   heavier DB backups).
2. **DOCX in-place edit is the hardest op.** `docx` (npm) only generates; editing needs
   OOXML surgery (pizzip/docxtemplater vs raw jszip+XML). Complex docs (tracked changes,
   nested tables, fields) can corrupt — mitigate by editing a copy, keeping the original
   (`supersedesId`), and bounding P3 to paragraph-scope `replace_text` + template
   placeholder fill.
3. **PDF forms reality check:** pdf-lib handles AcroForm only — XFA forms unsupported,
   digitally-signed PDFs invalidate on modification, and "forms" that are just flat
   scanned pages need the vision lane (P4) + annotation overlay, not field fill.
4. **SheetJS CE write fidelity:** no style preservation on round-trip; acceptable for
   data spreadsheets, not for "fix one cell in my formatted report" — may force `exceljs`
   (MIT) in P3.
5. **Anonymous chats:** `/upload` is `optionalAuthenticate`, but platform tools require an
   authenticated `ToolContext.userId` — document tools will simply be unavailable to
   anonymous sessions (degrade message like other platform tools). Confirm desired UX.
6. **Child (Digby Kids) tokens:** documents routes use `rejectChild`; platform-tool
   execution path needs the equivalent guard for document tools — verify how
   `executePlatformTool` sees child tokens today before P2.
7. **CPU-bound generation in the API process** (pdf-lib/docx on 25 MB inputs) — fine at
   current scale; move to the coding worker if telemetry shows event-loop stalls.
8. **Test-pin churn is expected:** `EXPECTED_TOOLS` + fleet pins fail by design when a
   tool is added — update them in the same PR (they are the tripwire, not a bug).
9. **Storage cost/lifecycle:** agent-generated files accumulate; consider a per-user
   quota or retention policy (none exists for ProjectDocument today either).

---

## Appendix — anchor index

| What | Where |
|---|---|
| Chat upload READ | `backend/src/modules/crossmodel/upload.controller.ts:230` (PDF `:274`, DOCX `:307`, XLSX `:321`, text `:346`, auto-ingest `:380`) |
| Tiered PDF extractor | `backend/src/modules/crossmodel/pdf-extract.ts:126` (vision OCR `:88`) |
| RAG ingestion | `backend/src/modules/crossmodel/ingestion.service.ts:68` / `processDocument` |
| Knowledge upload | `backend/src/modules/crossmodel/documents.controller.ts:118` |
| Drive/Gmail READ | `google/google-mcp.ts:284`, `coding/integration-tool-schema.ts:77` |
| Files model | `backend/prisma/schema.prisma:346` (chunks `:370`, canvas `:390`) |
| Files API | `sharing.routes.ts:15` → `sharing.controller.ts:206`; routes mount `backend/src/app.ts:271-276` |
| Files UI | `frontend/app/crossmodel/files/page.tsx`, `frontend/lib/api/crossmodel.ts:466` |
| Tool registration | `platform/platform-tool-names.ts:16/32/65`, `platform/platform-tools.ts:70/760/1009/1039`, `coding/agent-profiles.ts:60` |
| Installed deps | `backend/package.json:49` (mammoth), `:51` (pdf-parse), `:57` (xlsx) |
