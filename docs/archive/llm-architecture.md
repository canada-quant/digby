# CrossModel — LLM Architecture Reference

> ⚠️ STALE (2026-08-14): superseded by the 2026-08-01 lineup in chat-agent.service.ts (Kimi K3 orchestrates all levels); kept for history.


> Deep-dive reference for AI/LLM integrations. For the quick-start overview see CLAUDE.md.

---

## Model Matrix (Current — March 2026)

### Frontier Mode

| Config | OpenAI | Grok (xAI) | Gemini (Google) |
|--------|--------|------------|-----------------|
| Fast, no web | `gpt-5-mini` | `grok-4-1-fast` | `gemini-3-flash-preview` |
| Fast + web | `gpt-5.2` (effort:low, Responses API) | `grok-4-1-fast` + web_search | `gemini-3-flash-preview` + googleSearch |
| Thinking, no web | `gpt-5.2` | `grok-4` (grok-4-0709) | `gemini-3-pro-preview` |
| Thinking + web | `gpt-5.2` (effort:high, Responses API) | `grok-4` + web_search + x_search | `gemini-3-pro-preview` + googleSearch |

**Synthesizer (Frontier):** `kimi-k2p5` via Fireworks AI (streaming, Digby persona)

### Open Source Mode

| Role | Model | Provider | Mode |
|------|-------|----------|------|
| Primary query | `glm-5p1` | Fireworks AI | User's choice |
| Synthesizer + Cross-checker | `deepseek-v4-pro` | DeepSeek direct API | fast → thinking |
| Reasoning validator | `kimi-k2-instruct-0905` | Fireworks AI | ALWAYS fast |
| Synthesis (self-patch) | `glm-5p1` (analyzeAndSynthesizeStream) | Fireworks AI | Streaming |
| Fallback synthesizer | `kimi-k2p5` (if GLM fails) | Fireworks AI | Streaming |

### Utility Models (Background Tasks)

| Task | Model | Provider |
|------|-------|----------|
| Chat title generation | `kimi-k2-instruct-0905` | Fireworks AI |
| Follow-up questions | `kimi-k2-instruct-0905` | Fireworks AI |
| Live commentary | `kimi-k2-instruct-0905` | Fireworks AI |
| Memory consolidation | `kimi-k2-instruct-0905` | Fireworks AI |
| Context compression | `llama-v3p3-70b-instruct` | Fireworks AI |
| Memory extraction | `llama-v3p3-70b-instruct` | Fireworks AI |
| LangGraph background | `llama-v3p3-70b-instruct` | Fireworks AI |
| RAG contextualization | `kimi-k2-instruct-0905` | Fireworks AI |
| RAG embeddings (frontier) | `text-embedding-3-small` | OpenAI |
| RAG embeddings (open source) | `qwen3-embedding-8b` | Fireworks AI |
| RAG reranking | Rerank API | Cohere |

---

## Integration Files

### `backend/src/modules/crossmodel/integrations/`

| File | Exports | Purpose |
|------|---------|---------|
| `openai.integration.ts` | `openaiIntegration.query()` | GPT-5-mini / GPT-5.2, Chat + Responses API |
| `grok.integration.ts` | `grokIntegration.query()` | Grok-4-1-fast / Grok-4, Chat + Responses API |
| `gemini.integration.ts` | `geminiIntegration.query()` | Gemini-3-flash / Gemini-3-pro, generateContent |
| `moonshot.integration.ts` | `synthesize()`, `synthesizeStream()`, `query()`, `generateTitle()`, `generateFollowUps()`, `generateLiveCommentary()`, `consolidateMemory()`, `profileStream()` | ALL Fireworks AI calls (Kimi K2.5, Kimi K2, Llama) |
| `glm.integration.ts` | `query()`, `analyzeAndSynthesizeStream()` | GLM-5.1 primary + synthesis stream |
| `deepseek.integration.ts` | `query()` / `analyzeAndSynthesizeStream()` | DeepSeek V4 Flash/Pro primary + synthesizer |

---

## Fireworks AI API Details

**Base URL:** `https://api.fireworks.ai/inference/v1/chat/completions`
**Auth:** `Authorization: Bearer ${FIREWORKS_API_KEY}`

### Model Name Format
All models use the full path: `accounts/fireworks/models/<model-name>`

### Kimi K2.5 (kimi-k2p5) — Streaming Synthesizer
- ALWAYS generates reasoning tokens before content
- Streaming: `delta.reasoning_content` = chain-of-thought (SKIP), `delta.content` = answer (yield)
- Non-streaming: `message.reasoning_content` = thinking, `message.content` = answer
- **HARD LIMIT: `max_tokens <= 4096` for non-streaming**; use `stream: true` for more
- Do NOT pass `reasoning: { enabled: true }` — it always reasons automatically

### Kimi K2 Instruct (kimi-k2-instruct-0905) — Non-thinking Utility
- No reasoning overhead — responds in 5-20s
- Safe for non-streaming JSON output calls (titles, memory consolidation)
- All utility functions should use this model, NOT kimi-k2p5

### GLM-5.1 (glm-5p1)
- Standard OpenAI-compatible format
- `analyzeAndSynthesizeStream()` uses `temperature: 0.6`, always streaming
- Blank response bug: handled by checking `content` field before yielding
- Vision: standard `image_url` format

### DeepSeek V4 Flash/Pro (deepseek-v4-flash / deepseek-v4-pro)
- `max_tokens: 4096` (Fireworks non-streaming limit — do not exceed)
- `temperature: 0.6`
- Text-only — no native vision support (images handled as extracted text)

### Llama 3.3 70B (llama-v3p3-70b-instruct)
- Used for ALL context compression and memory extraction
- ONLY confirmed working Llama model on Fireworks (v3p1 and v3p2 are 404)

---

## OpenAI Integration Details

**Chat API:** `https://api.openai.com/v1/chat/completions`
**Responses API:** `https://api.openai.com/v1/responses` (web search only)

- `gpt-5-mini` and `gpt-5.2` are reasoning models — NEVER pass `temperature`
- Web search uses Responses API with `{ type: "web_search" }` tool
- Fast + web: `reasoning: { effort: "low" }` (~15s)
- Thinking + web: `reasoning: { effort: "high" }` (~84s)

### Timeouts
| Config | Timeout |
|--------|---------|
| Chat Completions | 60s |
| Responses API (effort:low) | 90s |
| Responses API (effort:high) | 180s |

---

## xAI Grok Integration Details

**Chat API:** `https://api.x.ai/v1/chat/completions`
**Responses API:** `https://api.x.ai/v1/responses` (web search only)

- Fast model: `grok-4-1-fast`
- Thinking model: `grok-4` (model ID in API: `grok-4-0709`)
- Web search tools: `[{ type: "web_search" }, { type: "x_search" }]` (Responses API)
- Timeout: 90s standard
- Transient 500 errors from xAI infra: retry once with 2s delay

---

## Google Gemini Integration Details

**Endpoint:** `https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent?key={apiKey}`

- Fast: `gemini-3-flash-preview`
- Thinking: `gemini-3-pro-preview`
- Web search: `tools: [{ googleSearch: {} }]` (NOT `google_search_retrieval`)
- Role names: `user` and `model` (NOT `assistant` — Gemini-specific!)
- `webSearch` parameter must be boolean `true`, not string `"true"`

### Timeouts
| Config | Timeout |
|--------|---------|
| Fast (no web) | 90s |
| Thinking (no web) | 150s |
| Thinking + web | 150s (can take 90-120s in practice) |

---

## BrightData MCP (Web Search)

**URL:** `https://mcp.digby.ai/`
**Protocol:** JSON-RPC 2.0 over HTTP POST
**Auth:** `X-API-Key: ${MCP_DIGBY_TOKEN}` (NOT Bearer token)

```typescript
// Request format
{
  jsonrpc: '2.0',
  method: 'tools/call',
  params: {
    name: 'brightdata_search_engine',
    arguments: { query: string, engine: 'google' }
  }
}

// Response format
{ result: { content: [{ type: 'text', text: '...' }] } }
```

The search result is injected into the model's message as a `[WEB SEARCH RESULTS]` block before the user's question. All models (Frontier + Open Source) that have web search enabled receive this block.

---

## LangGraph Memory System

### Two Graphs in `langgraph/memory.graph.ts`

**`getContextGraph`** (sequential, awaited before query):
```
loadConversation → loadUserState → loadProjectState → buildContextBlocks
```
- `loadConversation`: loads chat history; trims to last 4 message pairs when count > 8
- Thread state injected as `[Conversation Thread — N exchanges so far]` in systemContext
- Output: `systemContext` string passed to all model integrations

**`updateContextGraph`** (fire-and-forget, NOT awaited):
```
loadExistingState (3 parallel DB reads) → extractUserContext → extractProjectState → extractThreadState
```
- ALL 3 extraction nodes use `llama-v3p3-70b-instruct` on Fireworks AI
- Thread state saved to `crossmodel_chats.threadState` JSONB column
- User facts saved to `user_memory.facts` JSONB column
- Project decisions saved to `crossmodel_projects.contextState` JSONB column

### State Types

```typescript
interface ConversationThreadState {
  threadSummary: string;     // 2-3 sentence narrative of conversation arc
  confirmedFacts: string[];  // facts confirmed across multiple messages
  openTopics: string[];      // ongoing questions/threads
  lastUserGoal: string;      // most recent user intent
  messageCount: number;      // total exchanges in conversation
}

interface UserContextState {
  name?: string;
  preferences?: Record<string, string>;
  recurringTopics?: string[];
}

interface ProjectContextState {
  decisions?: string[];
  entities?: Record<string, string>;
  openItems?: string[];
}
```

---

## Context Service Architecture

File: `backend/src/modules/crossmodel/context.service.ts`

### 4 Context Sources (in priority order injected into system prompt):

1. **DateTime block** — always included, answers time/date questions without web search
2. **User memory** — persistent facts from `user_memory` table (authenticated users)
3. **Anonymous session memory** — Redis key `cm_session:{sessionId}` (24h TTL)
4. **Conversation history** — last N message pairs (sliding window)
5. **Thread summary** — compressed narrative for long conversations (> 8 exchanges)
6. **Project system prompt** — custom instructions per project
7. **RAG context** — retrieved document chunks (if knowledge base has documents)

### Sliding Window
```typescript
MAX_HISTORY_PAIRS = 6        // 12 messages total
COMPRESSION_CHAR_THRESHOLD = 6000  // trigger auto-compress (~1.5k tokens)
```

When history exceeds `COMPRESSION_CHAR_THRESHOLD`, `compressHistory()` calls Llama to summarize older messages, stores the summary, and continues with fresh context.

### Anonymous Session Migration
When an anonymous user logs in, their Redis session (`cm_session:{id}`) is migrated into their `UserMemory` row in PostgreSQL.

---

## SSE Implementation Pattern

The `/api/crossmodel/stream` endpoint uses Node.js Server-Sent Events:

```typescript
// Controller sets SSE headers
res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');
res.flushHeaders();

// Helper to write events
function sendSSEEvent(res, eventType, data) {
  res.write(`event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Client disconnection handling
req.on('close', () => {
  aborted = true;
  // cleanup resources
});
```

Frontend uses `EventSource` API with polling the `?token=<jwt>` query param for authentication (EventSource cannot set custom headers).

---

## Parallel Execution Pattern

```typescript
// All 3 models called simultaneously with Promise.allSettled
const [openaiResult, grokResult, geminiResult] = await Promise.allSettled([
  openaiIntegration.query(message, mode, webSearch, systemContext, history, attachments),
  grokIntegration.query(message, mode, webSearch, systemContext, history, attachments),
  geminiIntegration.query(message, mode, webSearch, systemContext, history, attachments),
]);

// As each model result arrives, emit model-response event
// Then synthesize with the synthesizer (Kimi K2.5 streaming or GLM-5.1 synthesis)
```

Synthesis begins AFTER all parallel model calls complete (or timeout). Models have individual timeouts to prevent one slow model from blocking the entire pipeline.

---

## Follow-up Questions (Parsed from Synthesis Output)

The synthesizer (Kimi or GLM-5.1) is prompted to include:
```
[FOLLOWUPS]
- Question 1
- Question 2
- Question 3
[/FOLLOWUPS]
```

The controller strips these via regex and emits them as a separate `followups` SSE event.

---

## Canvas Artifact Detection

The synthesizer is prompted to produce canvas artifacts wrapped in:
```
[CANVAS type="document|code|html|mermaid|table" title="..." language="typescript"]
...content...
[/CANVAS]
```

Controller parses and saves `CanvasDocument` records to PostgreSQL after synthesis completes.

---

## Confirmed Working Fireworks Models (March 2026)

```
accounts/fireworks/models/kimi-k2p5                    WORKING
accounts/fireworks/models/kimi-k2-instruct-0905        WORKING
deepseek-v4-pro                                          WORKING (direct)
accounts/fireworks/models/glm-5p1                       WORKING
accounts/fireworks/models/llama-v3p3-70b-instruct      WORKING

accounts/fireworks/models/llama-v3p1-8b-instruct       404 DEAD
accounts/fireworks/models/llama-v3p1-70b-instruct      404 DEAD
accounts/fireworks/models/llama-v3p3-8b-instruct       404 DEAD
accounts/fireworks/models/gpt-oss-20b                  404 DEAD (listed but fails)
```
