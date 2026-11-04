'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, MessagesSquare, Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import {
  Command,
  CommandInput,
  CommandList,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { crossModelApi, type ChatSearchResult } from '@/lib/api/crossmodel';

interface DeepSearchDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Open the chat behind a result — reuses the sidebar loadChat path. */
  onSelect: (chatId: string) => void;
}

/** Bold the first case-insensitive occurrence of `q` inside `text`. */
function highlight(text: string, q: string): React.ReactNode {
  const query = q.trim();
  if (!query) return text;
  const idx = text.toLowerCase().indexOf(query.toLowerCase());
  if (idx < 0) return text;
  return (
    <>
      {text.slice(0, idx)}
      <mark className="rounded-sm bg-warn/10 px-0.5 text-foreground dark:bg-warn/30">
        {text.slice(idx, idx + query.length)}
      </mark>
      {text.slice(idx + query.length)}
    </>
  );
}

/**
 * Deep search across ALL of the user's chats + messages (ticket 4fd1de3c).
 * A command-palette-style dialog (reuses ui/dialog + ui/command) rather than an
 * inline sidebar box — page.tsx is ~7000 lines and heavily tangled, so an
 * isolated component keeps the search surface self-contained. Server search is
 * debounced (250ms); results are ranked server-side (title hits first, then
 * message hits). Selecting a result hands its chatId back to the page to open.
 */
export default function DeepSearchDialog({ open, onOpenChange, onSelect }: DeepSearchDialogProps) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<ChatSearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  // Monotonic request id: a slow earlier response must never overwrite a newer one.
  const reqSeq = useRef(0);

  // Reset on close so the dialog reopens clean.
  useEffect(() => {
    if (!open) {
      setQuery('');
      setResults([]);
      setLoading(false);
    }
  }, [open]);

  // Debounced server search — the box is keystroke-driven.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const seq = ++reqSeq.current;
    const timer = setTimeout(async () => {
      try {
        const r = await crossModelApi.searchChats(q);
        if (seq === reqSeq.current) setResults(r);
      } catch {
        if (seq === reqSeq.current) setResults([]);
      } finally {
        if (seq === reqSeq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const handleSelect = useCallback((chatId: string) => {
    onSelect(chatId);
  }, [onSelect]);

  const trimmed = query.trim();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseIcon={false} className="overflow-hidden p-0 sm:max-w-xl">
        {/* Radix a11y: the dialog needs an accessible name + description. */}
        <DialogTitle className="sr-only">Search chats</DialogTitle>
        <DialogDescription className="sr-only">
          Search across all your chats and messages.
        </DialogDescription>
        {/* shouldFilter=false: results are ranked/filtered on the server; cmdk
            must render exactly what we give it (and keep arrow-key nav). */}
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search all chats and messages…"
            autoFocus
          />
          <CommandList className="max-h-[60vh]">
            {trimmed.length < 2 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                Type at least 2 characters to search your chats.
              </div>
            ) : loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Searching…
              </div>
            ) : results.length === 0 ? (
              <div className="py-8 text-center text-sm text-muted-foreground">
                No chats or messages match &ldquo;{trimmed}&rdquo;.
              </div>
            ) : (
              <CommandGroup heading={`${results.length} result${results.length === 1 ? '' : 's'}`}>
                {results.map((r, i) => (
                  <CommandItem
                    key={`${r.chatId}:${r.messageRole ?? 'title'}:${r.matchedAt}:${i}`}
                    value={`${r.chatId}:${i}`}
                    onSelect={() => handleSelect(r.chatId)}
                    className="flex items-start gap-2"
                  >
                    {r.messageRole === null ? (
                      <MessagesSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    ) : (
                      <MessageSquare className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                    )}
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {r.messageRole === null ? highlight(r.chatTitle, trimmed) : r.chatTitle}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {r.messageRole === null ? (
                          'Chat title match'
                        ) : (
                          <>
                            <span className="font-medium">
                              {r.messageRole === 'user' ? 'You: ' : 'Digby: '}
                            </span>
                            {highlight(r.snippet, trimmed)}
                          </>
                        )}
                      </span>
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
