# CrossModel v2 — Architecture Redesign Plan

> ⚠️ STALE (2026-08-14): superseded by the current agentic chat-agent pipeline (backend/src/modules/crossmodel/chat-agent/) and the memory bank; GLM-5.1-era plan; kept for history.


> **Written**: March 11, 2026 (Session 47)  
> **Refined**: March 11, 2026 — detailed implementation spec  
> **Goal**: Build a proper LangGraph-powered memory system that eliminates destructive compression, and redesign the multi-model architecture so all models process the same request with the same capabilities, with the forefront model (GLM-5.1 / Gemini) performing holistic gap analysis on the others' responses.

---

## Context

The current LangGraph implementation is a facade — it wraps manual DB reads/writes in StateGraph nodes but uses none of LangGraph's actual capabilities: no checkpointers, no memory store, no thread management. Conversations are destructively compressed (original messages permanently deleted after 6000 chars). The multi-model orchestration assigns artificial roles (fact-checker, reasoning validator) to the secondary models instead of letting all models fully process the request.

---

## Phase 1: LangGraph Checkpointer + Eliminate Destructive Compression

**Objective**: Replace manual chat history management with PostgresSaver checkpointer. Stop destroying messages. Store everything, trim only when sending to models.

### 1.1 Install dependencies
```bash
npm install @langchain/langgraph-checkpoint-postgres
```

### 1.2 Create checkpointer singleton
**New file**: `backend/src/config/langgraph-checkpointer.ts`
- Initialize `PostgresSaver.fromConnString()` using existing `DATABASE_URL`
- Call `.setup()` on first use (creates checkpoint tables)
- Export singleton instance

### 1.3 Remove destructive compression from `context.service.ts`
**File**: `backend/src/modules/crossmodel/context.service.ts`
- **Delete** `buildSlidingWindow()` compression logic (lines 259-300)
- **Delete** `compressHistory()` (lines 316-359)
- **Delete** `persistCompressionMarker()` (lines 365-404)
- Replace with simple `loadChatHistory()` that returns ALL messages from DB
- Add `trimForModelContext(messages, maxPairs=6)` — trims messages only for LLM calls, never modifies DB
- Keep `COMPRESSION_CHAR_THRESHOLD` concept but as a **read-only** smart trim: when messages exceed threshold, include `[threadSummary]` + last 4 messages (same as current threadState behavior, but without data destruction)

### 1.4 Update `memory.graph.ts` to use checkpointer
**File**: `backend/src/modules/crossmodel/langgraph/memory.graph.ts`
- Compile graphs with checkpointer: `getContextGraph.compile({ checkpointer })`
- Pass `thread_id` (= chatId) in config when invoking: `graph.invoke(state, { configurable: { thread_id: chatId } })`
- The checkpointer auto-persists graph state per thread — no manual save needed
- **Make extraction nodes parallel**: Change update graph edges so `extractUserContext`, `extractProjectState`, `extractThreadState` run in parallel after `loadExistingState` (they're independent)

### 1.5 Backwards compatibility for existing chats
- Existing chats with compression markers (`[Auto-compressed conversation summary]`) continue to work — they're just messages in the array
- New chats will never have compression markers
- No migration needed — existing `crossmodel_chats.messages` JSONB stays as-is

### Verification
- Start a chat, send 20+ messages — verify no messages are deleted from DB
- Check that model queries still receive trimmed context (not all 20 messages)
- Verify thread state summary kicks in after 8 messages
- Check PostgresSaver tables are created (`checkpoints`, `checkpoint_blobs`, etc.)

---

## Phase 2: LangGraph Memory Store for User/Project State

**Objective**: Replace the `user_memory.facts.__contextState` hack with LangGraph's `PostgresStore` for structured cross-thread memory.

### 2.1 Initialize PostgresStore
**File**: `backend/src/config/langgraph-checkpointer.ts` (extend)
- Add `PostgresStore` from `@langchain/langgraph-checkpoint-postgres`
- Configure with same `DATABASE_URL`
- Namespace convention:
  - `(userId, "memory")` → user facts + context state
  - `(projectId, "context")` → project state
  - `(chatId, "thread")` → thread state

### 2.2 Refactor memory.graph.ts DB helpers
**File**: `backend/src/modules/crossmodel/langgraph/memory.graph.ts`
- Replace `loadUserContextState()` / `saveUserContextState()` → use `store.get/put` with namespace `(userId, "memory")`
- Replace `loadProjectContextState()` / `saveProjectContextState()` → use `store.get/put` with namespace `(projectId, "context")`
- Replace `loadThreadState()` / `saveThreadState()` → use `store.get/put` with namespace `(chatId, "thread")`
- Compile graph with store: `graph.compile({ checkpointer, store })`
- **Full migration to PostgresStore** — remove Prisma `user_memory` reads/writes for context state

### 2.3 Migrate existing data
- One-time migration script: read all existing `user_memory.facts.__contextState`, `crossmodel_projects.contextState`, `crossmodel_chats.threadState` and write to PostgresStore
- Run migration before deploying Phase 2
- After migration verified, remove Prisma context state code paths

### 2.4 Update types.ts
**File**: `backend/src/modules/crossmodel/langgraph/types.ts`
- Add `StoreNamespace` type definitions
- Add `MemoryItem` interface for Store entries

### Verification
- Verify user facts persist across different chats (cross-thread)
- Verify project context shared across project chats
- Verify thread state isolated per chat
- Check Store tables are populated

---

## Phase 3: Multi-Model Orchestration Redesign — Equal Processing

**Objective**: All three models process the same request with the same capabilities. No more role-specific prompts.

### 3.1 Remove role-specific system prompts from controller
**File**: `backend/src/modules/crossmodel/crossmodel.controller.ts`
- Remove `"YOUR ROLE: FACT-CHECKER"` and `"YOUR ROLE: REASONING VALIDATOR"` injections
- All three models receive the **identical** system context + user message
- All three models get the same `webSearch`, `attachment`, `conversationHistory` parameters

### 3.2 Enable web search for all models equally
**File**: `backend/src/modules/crossmodel/crossmodel.controller.ts`
- Currently: frontier models use native web search; open source models use BrightData
- Change: ALL models get web search when enabled — each model's integration handles it natively
- Frontier: OpenAI (Responses API), Grok (Responses API), Gemini (googleSearch) — all already support it
- Open Source: GLM, DeepSeek, Kimi all use BrightData — each gets its own search (results may differ = more diverse info)

### 3.3 Update model query calls — all use user's selected `mode`
**File**: `backend/src/modules/crossmodel/crossmodel.controller.ts`
- Currently: validators always use `'fast'` mode regardless of user selection
- Change: **All three models use the user's selected mode** (`fast` or `thinking`)
- Decision: All same depth — deeper thinking from all models when user selects thinking mode
- This gives the forefront model richer material to analyze in thinking mode

### 3.4 Ensure image/file processing works for all models
- OpenAI: Already has Files API + vision ✓
- Grok: Already has Files API + vision ✓
- Gemini: Already has Files API + vision ✓
- GLM: Routes to Qwen3-VL for images ✓
- DeepSeek: Text-only — pass image description context ✓ (already handled)
- Kimi: Text-only — pass image description context ✓ (already handled)

No changes needed here — all integrations already handle attachments.

### Verification
- Send same query to frontier mode — verify all 3 models get identical prompts (no role tags)
- Send query with web search — verify all models perform search independently
- Send image — verify all capable models process it
- Compare response quality before/after removing role constraints

---

## Phase 4: Forefront Model Analysis Redesign

**Objective**: Replace role-based `selfPatchStream()` with holistic gap analysis where the forefront model comprehensively analyzes all responses.

### 4.1 Redesign Gemini `selfPatchStream()` → `analyzeAndSynthesizeStream()`
**File**: `backend/src/modules/crossmodel/integrations/gemini.integration.ts`
- Rename method to reflect new purpose
- New prompt structure:
```
You are Digby, an expert AI assistant. You've been given your own draft response
and two independent analyses of the same question from other AI models.

YOUR DRAFT:
[gemini's response]

INDEPENDENT ANALYSIS 1 (OpenAI):
[openai's full response]

INDEPENDENT ANALYSIS 2 (Grok):
[grok's full response]

Produce the definitive response by:
1. FACT-CHECK: Identify any factual inconsistencies between the three responses
2. GAP ANALYSIS: Find information present in one response but missing from others
3. CORRECTIONS: Fix any errors in your draft using evidence from the other analyses
4. SYNTHESIS: Combine the strongest elements from all three into a comprehensive answer

Do NOT mention the other models or the analysis process. Write as if this is your natural response.
```
- Keep persona/tone customization (reads user memory for tech_level, style)
- Keep streaming via `streamGenerateContent`

### 4.2 Redesign GLM `selfPatchStream()` → `analyzeAndSynthesizeStream()`
**File**: `backend/src/modules/crossmodel/integrations/glm.integration.ts`
- Same prompt structure as Gemini, adapted for GLM:
```
YOUR DRAFT:
[glm's response]

INDEPENDENT ANALYSIS 1 (DeepSeek):
[deepseek's full response]

INDEPENDENT ANALYSIS 2 (Kimi):
[kimi's full response]
```
- Keep Fireworks streaming
- Keep recent conversation history injection (last 3 exchanges)

### 4.3 Update controller to pass full responses (not truncated)
**File**: `backend/src/modules/crossmodel/crossmodel.controller.ts`
- Currently: cross-check sections are truncated to 3000 chars each
- Change: Pass full responses (or increase limit significantly, e.g. 8000 chars)
- The forefront model needs the COMPLETE responses to do proper gap analysis

### 4.4 Update SSE events for new flow
**File**: `backend/src/modules/crossmodel/crossmodel.controller.ts`
- Change progress stage names:
  - `"query"` → `"processing"` (all models processing in parallel)
  - `"synthesis"` → `"analyzing"` (forefront model analyzing responses)
- Add new progress message: "Analyzing responses for gaps and inconsistencies..."

### Verification
- Send a factual question — verify the forefront model catches inconsistencies between models
- Send a complex question — verify the final response is more comprehensive than any single model's
- Check that web search results from different models produce richer final answers
- Verify streaming still works correctly with new prompt structure

---

## Phase 5: Frontend Updates

**Objective**: Update the UI to reflect the new architecture.

### 5.1 Update progress messages
**File**: `frontend/app/crossmodel/page.tsx`
- Update status cycling messages to reflect "all models processing" instead of role-specific
- Update synthesis stage label from "Synthesizing" to "Analyzing & synthesizing"
- Update model card labels — remove "Fact-Checker" / "Reasoning Validator" badges

### 5.2 Update model timing display
- Show all models as equal processors (same visual weight)
- No role-specific icons/badges
- Each model card shows: model name, response time, web search indicator, content

### 5.3 Display follow-ups (currently broken)
- Follow-up suggestions are extracted but never rendered in the UI
- Add clickable suggestion buttons after each response

### Verification
- Visual check: all model cards look equal (no role badges)
- Progress messages match new stages
- Follow-up suggestions appear and work when clicked

---

## Files Modified (Summary)

| File | Action |
|------|--------|
| `backend/package.json` | Add `@langchain/langgraph-checkpoint-postgres` |
| `backend/src/config/langgraph-checkpointer.ts` | NEW — PostgresSaver + PostgresStore singletons |
| `backend/src/modules/crossmodel/langgraph/memory.graph.ts` | Refactor: use checkpointer, Store, parallel extraction |
| `backend/src/modules/crossmodel/langgraph/types.ts` | Add Store namespace types |
| `backend/src/modules/crossmodel/context.service.ts` | Remove destructive compression, add read-only trim |
| `backend/src/modules/crossmodel/crossmodel.controller.ts` | Remove role prompts, equal model queries, new progress stages |
| `backend/src/modules/crossmodel/integrations/gemini.integration.ts` | selfPatchStream → analyzeAndSynthesizeStream |
| `backend/src/modules/crossmodel/integrations/glm.integration.ts` | selfPatchStream → analyzeAndSynthesizeStream |
| `frontend/app/crossmodel/page.tsx` | Update progress messages, model cards, add follow-ups |

---

## Implementation Order

Phases 1-2 (memory foundation) → Phase 3 (equal processing) → Phase 4 (analysis redesign) → Phase 5 (frontend). Each phase is independently deployable and testable. Phase 1 can ship alone without breaking anything.

---

## End-to-End Verification

1. Docker build: `docker compose -f docker-compose.prod.yml build backend`
2. Start: `docker compose -f docker-compose.prod.yml up -d backend`
3. Test streaming: `curl -N "https://digby.ai/api/crossmodel/stream?message=Hello&mode=fast&webSearch=false"`
4. Long conversation test: Send 20+ messages, verify no compression markers in DB
5. Cross-thread memory: Start new chat, verify user facts from previous chat are loaded
6. Equal processing test: Check backend logs — all 3 models should receive identical system prompts
7. Gap analysis test: Ask a factual question, verify final response is richer than any individual model's
8. Web search diversity test: Enable web search, check each model gets different search results
