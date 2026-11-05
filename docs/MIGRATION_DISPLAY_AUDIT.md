# Migration display audit — legacy `/crossmodel` transcript → `CodeSessionView`

Ticket **71b1fec6** (C3, commits `c15e54aea` / `4777e94a7`) retired the chat renderer that lived inside `frontend/app/crossmodel/page.tsx`. There were no separate `ChatMessage` / `MessageBubble` files. Every session now renders through `CodeSessionView` + `AssistantParts` (`code-transcript.tsx`).

The regression class is exclusivity. The legacy page was additive: tool steps came from `parts`, and markdown plus the email card came from `content`. The current body gate (`CodeSessionView` ~3680) is exclusive: `parts` XOR `content`. Plain-chat answers now always persist parts, so anything that only ran when `parts` was empty is hidden.

The footer under that gate (sources, follow-ups, canvas cards, thumbs, timestamps, transparency) still runs for both paths. This audit does not restore retired chrome (frontier fact-check, per-vendor model cards, PatiencePicker, composer depth, the deep-research quota badge, or the raw thinking stream).

## Matrix

| Feature | Legacy (`page.tsx` before `4777e94a7`) | Current, message has parts | Current, no parts | Status |
|---|---|---|---|---|
| `[SEND_EMAIL]` card | Parsed from `content` via `parseEmailDraft` | Parsed from text parts via `extractEmailFromParts` (landed 31a17fed6; quote-aware tag scan + no-raw-markup contract landed with ticket 8d7d07b0, 2026-10-19). Card body is cut from parts; a no-card block's body stays as prose; marker-free parts keep their bytes. Card parsing is STRICT (a malformed tag — e.g. an apostrophe in an unquoted value, ticket 0febb5f1 — yields no card); the display path cuts the tag only (linear tokenizer bounded at 4096 chars), so the body survives as prose whenever the tag's quotes terminate, it holds no bare `[`, and it closes within the bound — shapes outside that (a bare `[`, an unterminated quote, a tag past the 4096-char bound) take the broken-opener cut — to end-of-text when no closer token follows (a truncated streaming block), otherwise bounded at that next closer so the prose after the block survives. | `parseEmailDraft` + `PlainEmailCard` | Present. |
| `[FOLLOWUPS]` chips | Parsed from content | Footer `PlainFollowUps` from `metadata.followUps` (outside the gate). Marker stripped from persisted text parts. | Same footer | Present |
| `[CANVAS]` | Inline canvas from the content marker | Marker stripped. `CanvasInlineCard` + canvas panel | Same | Present |
| Sources / citations | RAG source pills; Google redirect unwrap | `PlainSourcesRow` + `resolveSourceUrl` from `metadata.sources` | Same | Present |
| User images / file chips | Attachment chips on the user row | Image parts and `metadata.attachments` render outside the body gate | Same | Present |
| Generated images, tool / plan / subagent / task cards | `AgentSteps` from parts | `AssistantParts` | Markdown only (by design — there are no parts) | Present on the parts path |
| Tables (GFM) | remark-gfm | `MarkdownContent` on text parts | `CodeTranscriptMarkdown` → same renderer | Present |
| Code copy button | Language label + copy on fenced blocks | `MarkdownCodeBlock` via `MarkdownContent` | Same | Present |
| KaTeX / math | Not a chat-message feature | Not rendered | Not rendered | Not lost |
| Mermaid in prose | Not a chat fence renderer. Canvas type `mermaid` only. | A ` ```mermaid ` fence is plaintext | Same | Not lost. Follow-up if prose mermaid is wanted. |
| Charts | No `[CHART]` marker in prompts or the legacy renderer | — | — | Not a feature |
| Feedback thumbs + reason chips, copy, retry | Thumbs, reasons (wrong / incomplete / slow / formatting / harmful / other), copy, retry | `PlainMessageActions` footer, both paths | Same | Present |
| Timestamps | Row time | `data-msg-time` on the actions row; `PartTime` on multi-part messages | Same | Present |
| Thinking / reasoning stream | Thinking summary under the answer | Withheld from the wire (2026-10-04). Status voice + `ThinkingAd` + DepthPill "still working" | Same | Replaced. Do not restore the raw stream. |
| Model badges, cost, mode badges, synthesis time | Per-vendor cards, mode badge, timings | `TransparencyPill` + admin-only `HowDigbyAnswered`. Minimal view strips model ids. | Same | Retired. Do not restore. |
| Patience picker, composer depth, deep-research quota | Composer controls | Removed 2026-10-06 (roster B-3) | — | Retired. Do not restore. |
| Frontier "Check for Errors" | Veteran / Maverick / Scholar cards | Deleted with frontier consultants (2026-09-22) | — | Retired. Do not restore. |
| Ask-user card | `AskUserCard` under the stream | Pending-question card (~3960) | Same | Present |
| Owner-question card | In-flow card | `OwnerQuestionCard` (~4029), answerable in place | Same | Present |
| Queued-message caption | "Queued #N" plus a busy-chat notice; edit + dismiss on the echo | "Queued — runs when this turn finishes" (plain) / "Queued — folds into the run at its next step" (coding). Provisioning queue: "Queued — sends as soon as the session is ready". | Same | Present. Wording changed. |
| Deep link `id="msg-<id>"` | Not found on the deleted page | History rows in `CodeSessionView` | Same rows (the id is on the row, not the body) | **Fixed this PR.** `data-msg-id` was already the in-page scroll handle. `id="msg-<id>"` is the URL fragment. Also on `SupervisorChatTab` ordinary rows. |

## Markers the model is still taught

| Marker | Taught | Persisted | Renderer on the parts path |
|---|---|---|---|
| `[FOLLOWUPS]` | `moonshot.integration.ts`, `synthesis-prompts.ts`, capability doctrine | Stripped (`stripAnswerMarkup`, sse-adapter). Saved as `metadata.followUps`. | Yes — footer chips |
| `[CANVAS]` | Shared AI rules / canvas doctrine | Stripped from text parts | Yes — canvas panel + `CanvasInlineCard` |
| `[SEND_EMAIL]` | `integration-context.ts` | **Kept** in content and in text parts | Yes — `extractEmailFromParts` (since 31a17fed6; quote-aware tag scan since ticket 8d7d07b0) |

No `[SOURCES]` or `[CHART]` marker is taught. Sources ride `metadata.sources`.

## What this PR changes

- `id="msg-<id>"` on persisted history rows in `CodeSessionView` and on ordinary rows in `SupervisorChatTab`, next to the existing `data-msg-id`.
- Source pin in `c1-convergence-smoke.test.tsx` (these views are source-pinned; EventSource and effects make a full mount impractical).
- Special early returns stay without an id: `AgentMessageCard`, `MachineWakeBlock`, `MinimalNoteLine`. They never carried `data-msg-id`. The live streaming block has no persisted message id.

## Follow-ups (not done here)

1. **Email card inside text parts.** ~~`extractEmailFromParts` is owned by another PR. Do not add a second parser.~~ Landed: 31a17fed6 (parts card) and ticket 8d7d07b0 (quote-aware tag scan, no-raw-markup contract on every path).
2. **Open-in-chat fragment.** Inbox, Files, Dashboard, Schedules, and Feeds still navigate with `/?chatId=` only. Those payloads have a chat id, not a message id. Wiring `#msg-<id>` needs the message id in the payload first.
3. **Mermaid fences in prose.** Canvas mermaid is the supported path. A fenced mermaid block in an answer renders as plaintext.
4. **Queued-echo edit / dismiss.** Legacy let the user edit a queued echo back into the composer or dismiss it. Current queues are caption-only. Restoring that control is a composer change, not a parts-path fix.
