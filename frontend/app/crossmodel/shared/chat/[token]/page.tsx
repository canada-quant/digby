'use client';

import { useState, useEffect } from 'react';
import { absoluteDate } from '@/lib/relative-time';
import { useParams } from 'next/navigation';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Button } from '@/components/ui/button';
import { Zap, Brain, Search, FolderOpen, ExternalLink, Combine } from 'lucide-react';
import { BrandLogo } from '@/components/ui/custom/BrandLogo';
import { BrandSpinner } from '@/components/ui/custom/BrandSpinner';
import { useBranding } from '@/app/branding/BrandingProvider';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { sharingApi, type SharedChat, type SharedChatMessage } from '@/lib/api/crossmodel';
import { SharedChatImages } from './shared-chat-images';
import { rewriteFileSchemeLinks } from '@/components/ui/custom/prompt/file-link-card';
import { markdownTableComponents } from '@/components/ui/custom/prompt/markdown-table';
import { cn } from '@/lib/utils';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export default function SharedChatPage() {
  const branding = useBranding();
  const params = useParams();
  const token = params.token as string;

  const [chat, setChat] = useState<SharedChat | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    sharingApi.getSharedChat(token)
      .then(setChat)
      .catch(err => {
        setError(err?.response?.data?.error || 'Failed to load shared chat');
      })
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <BrandSpinner size={28} alt={branding.name} className="size-7 object-contain" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background text-center px-4">
        <div className="size-12 rounded-xl bg-destructive/10 flex items-center justify-center mb-4">
          <Combine className="size-6 text-destructive" />
        </div>
        <h1 className="text-xl font-bold mb-2">Link not available</h1>
        <p className="text-muted-foreground text-sm mb-4">{error}</p>
        <Button variant="outline" onClick={() => window.location.href = '/'}>
          Open {branding.name}
        </Button>
      </div>
    );
  }

  if (!chat) return null; // loading and error are handled above; nothing to render without a payload

  const messages: SharedChatMessage[] = chat.messages || [];

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx). The root IS the
    // scroll container so the sticky header sticks inside it.
    <div className="h-dvh overflow-y-auto bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 sticky top-0 z-10 backdrop-blur-sm" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="size-8 rounded-xl overflow-hidden flex-shrink-0">
            <BrandLogo compact size={32} className="w-full h-full object-cover" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="font-bold text-sm truncate">{chat.title}</h1>
            <p className="text-xs text-muted-foreground">
              Shared by {chat.ownerName} · {absoluteDate(chat.sharedAt)}
            </p>
          </div>
          {chat.project && (
            <Badge variant="outline" className="text-xs gap-1 flex-shrink-0">

              {chat.project.name}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            className="flex-shrink-0 gap-1.5"
            onClick={() => window.open('/', '_blank')}
          >
            <ExternalLink className="size-3.5" />
            <span className="hidden sm:inline">Try {branding.name}</span>
          </Button>
        </div>
      </header>

      {/* Messages */}
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {messages.map((message, index) =>
          message.role === 'user' ? (
            <div key={index} className="flex justify-end">
              <div className="max-w-[80%] min-w-0 rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-4 py-3">
                <p className="text-sm leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</p>
              </div>
            </div>
          ) : (
            <div key={index} className="flex justify-start">
              <div className="max-w-[92%] w-full min-w-0">
                <Card className="overflow-hidden border shadow-sm">
                  <div className="flex items-center gap-2 px-5 pt-4 pb-2">
                    <div className="size-5 rounded-md overflow-hidden flex-shrink-0">
                      <BrandLogo compact size={20} className="w-full h-full object-cover" />
                    </div>
                    <span className="text-[12px] font-medium text-ink-3">
                      {branding.name}&apos;s Best Answer
                    </span>
                    <div className="ml-auto">
                      <Badge variant="secondary" className="text-xs capitalize">
                        {message.metadata?.mode === 'deep_research' ? (
                          <><Search className="size-3 mr-1" />Deep Research</>
                        ) : message.metadata?.mode === 'thinking' ? (
                          <><Brain className="size-3 mr-1" />Thinking</>
                        ) : message.metadata?.mode === 'single_thinking' ? (
                          <><Brain className="size-3 mr-1" />Single Thinking</>
                        ) : message.metadata?.mode === 'single' ? (
                          <><Zap className="size-3 mr-1" />Single</>
                        ) : (
                          <><Zap className="size-3 mr-1" />Fast</>
                        )}
                      </Badge>
                    </div>
                  </div>
                  <Separator />
                  <div className="px-5 py-4">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={{
                        p: ({ children }) => <p className="leading-7 mb-3 last:mb-0">{children}</p>,
                        h1: ({ children }) => <h1 className="text-2xl font-bold mt-6 mb-3 first:mt-0">{children}</h1>,
                        h2: ({ children }) => <h2 className="text-xl font-semibold mt-5 mb-2 first:mt-0 border-b pb-1">{children}</h2>,
                        h3: ({ children }) => <h3 className="text-lg font-semibold mt-4 mb-2 first:mt-0">{children}</h3>,
                        ul: ({ children }) => <ul className="my-3 pl-6 list-disc space-y-1.5">{children}</ul>,
                        ol: ({ children }) => <ol className="my-3 pl-7 list-decimal space-y-1.5 marker:tabular-nums">{children}</ol>,
                        li: ({ children }) => <li className="leading-7 pl-1">{children}</li>,
                        // Tables — the shared MarkdownTable slice (P4: this copy
                        // had silently dropped the iOS momentum-scroll fix).
                        ...markdownTableComponents({ thClassName: 'text-xs sm:text-sm', tdClassName: 'text-xs sm:text-sm' }),
                        strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
                        a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary underline underline-offset-4 hover:opacity-80">{children}</a>,
                        code: ({ className, children }: any) => {
                          if (!className) return <code className="rounded bg-muted px-[0.35rem] py-[0.15rem] font-mono text-sm border">{children}</code>;
                          return <pre className="my-3 overflow-x-auto rounded-lg border bg-muted/70 p-4"><code className={cn('font-mono text-sm', className)}>{children}</code></pre>;
                        },
                      }}
                    >
                      {rewriteFileSchemeLinks(message.content)}
                    </ReactMarkdown>
                  </div>

                  {/* Generated images (generate_image tranche B, 2026-09-24):
                      framed figures under the markdown, loaded from the
                      token-scoped public byte route — the payload carries
                      only generated images, never tool parts or base64. */}
                  <SharedChatImages token={token} images={message.images} />

                  {/* "More info" model-details accordion removed (owner directive
                      2026-07-24): it is an admin-only debugging surface, and shared
                      chat viewers are never admins. */}
                </Card>
              </div>
            </div>
          )
        )}

        {/* CTA footer */}
        <div className="text-center py-8 border-t mt-8">
          <div className="size-12 rounded-2xl overflow-hidden shadow-lg mx-auto mb-4">
            <BrandLogo size={48} className="w-full h-full object-cover" />
          </div>
          <h3 className="font-bold text-lg mb-1">Try {branding.name} for free</h3>
          <p className="text-sm text-muted-foreground mb-4">Ask any question — multiple AI models work together to give you the best answer.</p>
          <Button
            className="bg-send text-send-ink hover:opacity-90 border-0"
            onClick={() => window.open('/', '_blank')}
          >
            Start chatting
          </Button>
        </div>
      </div>
    </div>
  );
}
