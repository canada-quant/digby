# CrossModel AI Chat Aggregator - Build Plan

> ⚠️ STALE (2026-08-14): founding-era plan, kept for history; current direction: docs/ONE_SESSION_PLATFORM.md + memory-bank; kept for history.


## Project Overview
**CrossModel** is an AI chat aggregator that queries multiple frontier AI models simultaneously and uses Kimi K2.5 to synthesize their responses into a unified, comprehensive answer. The app supports two modes (Fast & Thinking) and includes web search capabilities.

## Architecture

### High-Level Flow
```
User Query → Backend API → [Parallel Calls]
                            ├── OpenAI (GPT-5 mini / Chat 5.2)
                            ├── Grok (fast-non-reasoning / fast-reasoning)
                            └── Gemini (3 flash / 3 pro)
                            ↓
                          Collect Responses
                            ↓
                          Kimi K2.5 (Moonshot API)
                            ↓
                          Synthesized Summary
                            ↓
                          Stream to Frontend
```

### Technology Stack
- **Frontend**: Next.js 16 + React 19 + shadcn/ui + Tailwind CSS
- **Backend**: Node.js + Express + TypeScript
- **Database**: PostgreSQL (for chat history)
- **Streaming**: Server-Sent Events (SSE)
- **Docker**: Full containerization

## API Keys & Model Configuration

### 1. Moonshot API (Kimi K2.5)
- **API Key**: `***SCRUBBED-2026-08-31***`
- **Endpoint**: `https://api.moonshot.cn/v1/chat/completions`
- **Model**: `moonshot-v1-128k` (for thinking mode with long context)

### 2. OpenAI API
- **API Key**: `***SCRUBBED-2026-08-31***`
- **Models**:
  - Fast: `gpt-5-mini` (latest fast model)
  - Thinking: `o1` or latest reasoning model
- **Web Search**: Use OpenAI's native web search tool

### 3. xAI Grok API
- **API Key**: `***SCRUBBED-2026-08-31***`
- **Endpoint**: `https://api.x.ai/v1/chat/completions`
- **Models**:
  - Fast: `grok-4-1-fast-non-reasoning`
  - Thinking: `grok-4-1-fast-reasoning`
- **Web Search**: TBD (need to research Grok's API documentation)

### 4. Google Gemini API
- **API Key**: `***SCRUBBED-2026-08-31***`
- **Endpoint**: `https://generativelanguage.googleapis.com/v1/models/[model]:generateContent`
- **Models**:
  - Fast: `gemini-2.0-flash-exp` or `gemini-1.5-flash`
  - Thinking: `gemini-2.0-flash-thinking-exp` or `gemini-1.5-pro`
- **Web Search**: Use Google's Search Grounding tool

## Database Schema

### Chat Table (Extended)
```prisma
model CrossModelChat {
  id          String   @id @default(uuid())
  userId      String
  title       String
  mode        String   // 'fast' or 'thinking'
  messages    Json     // Array of message objects
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
  
  user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  
  @@map("crossmodel_chats")
  @@index([userId])
}
```

### Message Structure
```typescript
interface Message {
  role: 'user' | 'assistant';
  content: string;
  timestamp: string;
  metadata?: {
    mode: 'fast' | 'thinking';
    models: {
      openai: { response: string; time: number; error?: string };
      grok: { response: string; time: number; error?: string };
      gemini: { response: string; response: string; time: number; error?: string };
    };
    summary: string;
    totalTime: number;
  };
}
```

## Backend Implementation

### Module Structure
```
backend/src/modules/crossmodel/
├── crossmodel.controller.ts    # HTTP handlers + SSE streaming
├── crossmodel.service.ts       # Business logic + AI orchestration
├── crossmodel.routes.ts        # Route definitions
├── crossmodel.validation.ts    # Zod schemas
├── integrations/
│   ├── openai.integration.ts   # OpenAI API client
│   ├── grok.integration.ts     # Grok API client
│   ├── gemini.integration.ts   # Gemini API client
│   └── moonshot.integration.ts # Kimi/Moonshot API client
└── types.ts                    # TypeScript interfaces
```

### Key Features

#### 1. Parallel Model Execution
- Use `Promise.allSettled()` to call all 3 models simultaneously
- Handle individual model failures gracefully
- Track response times per model

#### 2. Streaming Response
- Use Server-Sent Events (SSE) for real-time updates
- Stream progress updates:
  1. "Querying OpenAI..."
  2. "Querying Grok..."
  3. "Querying Gemini..."
  4. "OpenAI responded ✓"
  5. "Synthesizing with Kimi..."
  6. Stream final summary

#### 3. Web Search Integration
- **OpenAI**: Add `tools` parameter with web search
- **Grok**: Research API docs for web search capability
- **Gemini**: Use `google_search_retrieval` tool

#### 4. Mode Selection
- Fast mode: Use fast models, shorter context
- Thinking mode: Use reasoning models, longer context, chain-of-thought

## Frontend Implementation

### Page Structure
```
frontend/app/crossmodel/
├── page.tsx                    # Main chat interface
├── components/
│   ├── ChatInput.tsx          # Input with mode selector
│   ├── MessageList.tsx        # Scrollable message list
│   ├── MessageBubble.tsx      # Individual message with metadata
│   ├── ModelResponses.tsx     # Accordion for model responses
│   ├── StreamingIndicator.tsx # Loading/streaming indicator
│   └── ModeToggle.tsx         # Fast/Thinking mode switch
└── hooks/
    └── useStreamingChat.ts    # Custom hook for SSE
```

### UI Design

#### Chat Input (Bottom)
```
┌─────────────────────────────────────────────────────┐
│ [Fast ▼]  Type your question...           [Send →] │
└─────────────────────────────────────────────────────┘
```

#### Message Display
```
┌─────────────────────────────────────────────────────┐
│ User: What is quantum computing?                    │
│                                                      │
│ ┌─ Summary (Synthesized by Kimi) ─────────────────┐ │
│ │ Quantum computing is... [streaming text]        │ │
│ └─────────────────────────────────────────────────┘ │
│                                                      │
│ ┌─ Individual Model Responses ▼ (Collapsed) ──────┐ │
│ │ > OpenAI GPT-5 Mini (0.8s)                       │ │
│ │ > Grok 4.1 Fast (1.2s)                          │ │
│ │ > Gemini 3 Flash (0.9s)                         │ │
│ └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

#### Expanded Accordion
```
┌─ Individual Model Responses ▲ (Expanded) ──────────┐
│ ┌─ OpenAI GPT-5 Mini (0.8s) ──────────────────┐   │
│ │ Response from OpenAI...                       │   │
│ └──────────────────────────────────────────────┘   │
│ ┌─ Grok 4.1 Fast (1.2s) ───────────────────────┐   │
│ │ Response from Grok...                         │   │
│ └──────────────────────────────────────────────┘   │
│ ┌─ Gemini 3 Flash (0.9s) ──────────────────────┐   │
│ │ Response from Gemini...                       │   │
│ └──────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────┘
```

### Mode Selector
- Toggle between Fast and Thinking modes
- Visual indicator for current mode
- Info tooltip explaining the difference

### Streaming Implementation
```typescript
// Custom hook for SSE streaming
const useStreamingChat = () => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  
  const sendMessage = async (content: string, mode: 'fast' | 'thinking') => {
    setIsStreaming(true);
    
    const eventSource = new EventSource(
      `/api/crossmodel/stream?message=${encodeURIComponent(content)}&mode=${mode}`
    );
    
    eventSource.onmessage = (event) => {
      const data = JSON.parse(event.data);
      
      if (data.type === 'progress') {
        // Show progress indicator
      } else if (data.type === 'chunk') {
        // Append to current message
      } else if (data.type === 'complete') {
        // Finalize message
        setIsStreaming(false);
        eventSource.close();
      }
    };
  };
  
  return { messages, isStreaming, sendMessage };
};
```

## GitHub Repository Setup

### 1. Initialize New Repo
```bash
cd /Users/example/Development/crossmodel
git remote remove origin  # Remove old remote
git remote add origin https://github.com/example-org/crossmodel.git
git branch -M main
git push -u origin main --force  # Push to new repo
```

### 2. Repository Structure
```
crossmodel/
├── backend/
│   ├── src/
│   │   └── modules/
│   │       └── crossmodel/       # New CrossModel module
│   └── Dockerfile
├── frontend/
│   ├── app/
│   │   └── crossmodel/           # New CrossModel UI
│   └── Dockerfile
├── docker-compose.yml             # Updated services
├── .env.example                   # With all API keys
└── README.md                      # CrossModel documentation
```

## Docker Configuration

### Updated docker-compose.yml
- Keep existing services (postgres, redis, adminer)
- Update backend with new environment variables
- Update frontend with crossmodel page
- Add health checks for AI API endpoints

### Environment Variables
```env
# Existing vars...

# CrossModel API Keys
MOONSHOT_API_KEY=***SCRUBBED-2026-08-31***
OPENAI_API_KEY=***SCRUBBED-2026-08-31***
XAI_GROK_API_KEY=***SCRUBBED-2026-08-31***
GOOGLE_GEMINI_API_KEY=***SCRUBBED-2026-08-31***
```

## Testing Strategy

### 1. API Integration Tests
- Test each AI provider independently
- Test error handling for failed API calls
- Test timeout scenarios
- Test web search functionality

### 2. Streaming Tests
- Verify SSE connection
- Test chunked data delivery
- Test connection close

### 3. UI Tests
- Test mode switching
- Test accordion expand/collapse
- Test streaming indicator
- Test error states

## Development Phases

### Phase 1: Backend Foundation (2-3 hours)
1. Create CrossModel module structure
2. Implement API integrations (OpenAI, Grok, Gemini, Moonshot)
3. Create service for parallel execution
4. Implement SSE streaming endpoint
5. Add database schema for chat history
6. Test all API connections

### Phase 2: Frontend UI (2-3 hours)
1. Create CrossModel page structure
2. Build chat input with mode selector
3. Implement message list component
4. Create accordion for model responses
5. Add streaming indicator
6. Style with shadcn/ui components
7. Implement SSE client

### Phase 3: Integration & Testing (1-2 hours)
1. Connect frontend to backend
2. Test full flow with real API calls
3. Test error scenarios
4. Optimize streaming performance
5. Add loading states
6. Polish UI/UX

### Phase 4: Docker & Deployment (1 hour)
1. Update docker-compose.yml
2. Add environment variables
3. Test local Docker deployment
4. Update documentation
5. Push to GitHub

## Key Considerations

### Rate Limiting
- OpenAI: 500 RPM on paid tier
- Grok: TBD (check documentation)
- Gemini: 60 RPM on free tier
- Moonshot: TBD (check documentation)

### Error Handling
- Graceful degradation if 1-2 models fail
- Show partial results
- Log all errors for debugging
- User-friendly error messages

### Performance
- Parallel API calls save time
- Streaming provides immediate feedback
- Cache responses in database
- Use Redis for rate limit tracking

### Security
- Store API keys in environment variables
- Never expose keys to frontend
- Validate all user inputs
- Rate limit user requests

## Success Criteria
- ✅ All 3 frontier models respond correctly
- ✅ Kimi successfully synthesizes responses
- ✅ Streaming works smoothly in UI
- ✅ Mode selection (Fast/Thinking) works
- ✅ Web search integration functional
- ✅ Individual responses visible in accordion
- ✅ Docker deployment successful
- ✅ GitHub repository synced
- ✅ Clean, professional UI
- ✅ Error handling robust

## Timeline
- **Planning**: 30 minutes ✅
- **Backend Development**: 2-3 hours
- **Frontend Development**: 2-3 hours
- **Integration & Testing**: 1-2 hours
- **Docker & Deployment**: 1 hour
- **Total**: 6-9 hours

## Next Steps
1. Review and approve plan
2. Set up GitHub repository sync
3. Start backend module implementation
4. Build frontend UI
5. Test and deploy locally with Docker
