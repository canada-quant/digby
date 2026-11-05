# CrossModel — Frontend Guide

> ⚠️ STALE (2026-08-14): predates the Management page, coding sessions, and the one-surface P2 work; page.tsx is far larger now; kept for history.


## Structure

```
frontend/
├── app/
│   ├── crossmodel/                   # Main application
│   │   ├── page.tsx                  # Primary chat UI (~2000 lines, single-file)
│   │   ├── layout.tsx                # Shell layout + metadata
│   │   ├── components/
│   │   │   └── CanvasPanel.tsx       # Slide-out canvas artifact viewer
│   │   ├── account/                  # Account settings (tabs: Profile, Memory, Models)
│   │   │   ├── page.tsx
│   │   │   ├── ProfileTab.tsx
│   │   │   ├── MemoryTab.tsx
│   │   │   └── ModelsTab.tsx
│   │   ├── files/page.tsx            # Project document browser
│   │   ├── projects/[id]/page.tsx    # Project view
│   │   └── shared/
│   │       ├── chat/[token]/page.tsx     # Public read-only chat
│   │       └── project/[token]/page.tsx  # Public read-only project
│   ├── dashboard/                    # Admin dashboard (separate from CrossModel)
│   ├── login/page.tsx
│   ├── page.tsx                      # Root redirect
│   ├── layout.tsx                    # Root layout (providers, fonts)
│   └── providers.tsx                 # Theme + toast providers
├── components/ui/                    # shadcn/ui primitives
│   └── custom/
│       ├── prompt/                   # Chat-specific components
│       │   ├── chat-container.tsx
│       │   ├── input.tsx
│       │   ├── message.tsx
│       │   ├── markdown.tsx
│       │   ├── loader.tsx
│       │   ├── suggestion.tsx
│       │   ├── code-block.tsx
│       │   └── scroll-button.tsx
│       └── tiptap/                   # Rich text editor (for admin dashboard content)
└── lib/
    ├── api/crossmodel.ts             # Typed API client
    ├── auth.ts                       # Auth utilities
    └── utils.ts                      # cn() and helpers
```

---

## CrossModel Main Page Architecture (`app/crossmodel/page.tsx`)

The entire CrossModel UI is in a single large client component. Key sections:

### State Management
- All state is local React `useState` / `useRef`
- No global store (Zustand not used in CrossModel pages)
- Auth state checked via `authApi.getMe()` on mount

### SSE Streaming Pattern
```typescript
const eventSource = new EventSource(
  `/api/crossmodel/stream?message=${encodeURIComponent(msg)}&mode=${mode}&webSearch=${webSearch}&token=${jwt}`
);

eventSource.addEventListener('init', (e) => { /* set modelSet */ });
eventSource.addEventListener('progress', (e) => { /* update status text */ });
eventSource.addEventListener('model-response', (e) => { /* update model cards */ });
eventSource.addEventListener('chunk', (e) => { /* append to synthesis text */ });
eventSource.addEventListener('followups', (e) => { /* store follow-up buttons */ });
eventSource.addEventListener('complete', (e) => {
  eventSource.close();
  // save chat, show canvases
});
eventSource.addEventListener('error', (e) => {
  eventSource.close();
});
```

### Stop Button
Calls `eventSource.close()` and sets `isStreaming = false`. The backend detects `req.on('close')` and aborts in-flight model queries.

### Total Time Bug Fix
Use `useRef` (not `useState`) to track total time across async closures. `useState` inside SSE event handlers causes stale closure issues.

```typescript
const totalTimeRef = useRef(0);
// In 'model-response' handler:
totalTimeRef.current = Math.max(totalTimeRef.current, data.time);
```

---

## UI Component Patterns

### Branding
- Icon: `Combine` from `lucide-react` (violet→blue gradient, represents Venn diagram)
- Wordmark: "CrossModel" — never mention "Kimi" to end users
- Synthesizer brand name: "Digby" (Kimi K2.5's persona in the app)
- Favicon: Venn diagram SVG (`app/icon.svg`) with violet→blue gradient

### Model Cards (in accordion)
Each model card shows:
- Model name badge (e.g., `gpt-5-mini`)
- Web search badge (blue "web" when active)
- Response time
- Green check (success) / Amber alert (empty response) / Red X (error)
- Expandable full response text

### Mode Selector
Fast (Zap icon) vs Thinking (Brain icon) button group. Persisted to user preferences via API.

### Web Search Toggle
Globe icon button toggles `webSearch` state. Affects next query only.

### Model Set Selector
Frontier (OpenAI/Grok/Gemini) vs Open Source (GLM/DeepSeek/Kimi) radio toggle. Saved to `UserPreferences.modelSet`.

### Rotating Status Messages
8 query phrases rotate while models are loading (not random, cycling via index). 8 synthesis phrases rotate while synthesis streams. Pattern avoids animation jitter.

---

## Shadcn/ui Components Used

All from `components/ui/`:
- `Accordion` — model response panels
- `Alert` — error states
- `AlertDialog` — delete confirmations
- `Avatar` — user icon
- `Badge` — model name, web search, timing
- `Button` — all buttons
- `Card` — message containers
- `Dialog` — share link, project settings
- `Input` — chat input, rename fields
- `Label` — form labels
- `ScrollArea` — chat history, sidebar
- `Separator` — section dividers
- `Table` — model response grids, markdown tables
- `Tooltip` — icon button tooltips
- `toast` (Sonner) — success/error toasts

---

## Markdown Rendering

Uses `react-markdown` + `remark-gfm` for full GFM support:
- Tables rendered with shadcn `Table` component
- Code blocks with copy button (from `custom/prompt/code-block.tsx`)
- Headings with appropriate spacing
- Blockquotes, bold, italic, lists all handled
- Images rendered with `next/image`

---

## Authentication Flow

1. `app/providers.tsx` wraps the app with theme + toast providers
2. `app/crossmodel/page.tsx` calls `authApi.getMe()` on mount
3. If authenticated: loads chat history, projects, user preferences
4. If anonymous: creates session ID (UUID), stores in cookie via backend
5. JWT stored in `Authorization` header for standard requests
6. JWT passed as `?token=<jwt>` for SSE (EventSource limitation)

---

## Projects & Sidebar

Left sidebar (collapsible) shows:
- "New Chat" button
- Ungrouped chats list (recent first)
- Projects accordion (each project shows its chats)
- Bottom: Files link, Account link

Project pages (`/crossmodel/projects/[id]`) show:
- Project description + system prompt
- All chats in this project
- Document knowledge base
- Share settings (viewer/editor roles)

---

## Canvas Panel

Slides out from the right side when AI generates a canvas artifact:
- `CanvasPanel.tsx` — renders the artifact
- Types: `document` (rich text), `code` (syntax highlighted), `html` (iframe preview), `mermaid` (diagram), `table` (data table)
- Multiple canvases per chat, stored in `CanvasDocument` records
- Editable in the panel, saved back via PUT API

---

## Key Import Paths

```typescript
import { Button } from '@/components/ui/button';
import { authApi } from '@/lib/auth';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import Image from 'next/image';
import { useRouter } from 'next/navigation';
```

---

## Environment Variables (Frontend)

```env
NEXT_PUBLIC_API_URL=http://localhost:4000  # backend base URL
```

In production (Docker), the frontend calls the backend via internal Docker network or the mapped host port.

---

## Next.js Config Notes

- `next.config.ts` (TypeScript) — requires TypeScript at runtime in Docker
- The production Dockerfile must copy `node_modules/typescript` from the build stage
- `images.remotePatterns` (not deprecated `images.domains`)
- No `eslint` key in next.config — use `.eslintrc` file
