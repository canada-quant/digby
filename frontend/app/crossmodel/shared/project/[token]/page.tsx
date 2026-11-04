'use client';

import { useState, useEffect } from 'react';
import { absoluteDate } from '@/lib/relative-time';
import { useParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Loader2, Combine, MessageSquare, FileText, Globe, ExternalLink } from 'lucide-react';
import { projectsApi } from '@/lib/api/crossmodel';

export default function SharedProjectPage() {
  const params = useParams();
  const token = params.token as string;

  const [project, setProject] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    projectsApi.getPublic(token)
      .then(setProject)
      .catch(err => {
        setError(err?.response?.data?.error || 'This folder is not publicly available');
      })
      .finally(() => setLoading(false));
  }, [token]);

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen bg-background">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center min-h-screen bg-background text-center px-4">
        <div className="size-12 rounded-xl bg-muted flex items-center justify-center mb-4 text-2xl">
          📁
        </div>
        <h1 className="text-xl font-bold mb-2">Folder not available</h1>
        <p className="text-muted-foreground text-sm mb-4">{error}</p>
        <Button variant="outline" onClick={() => window.location.href = '/'}>
          Open Digby
        </Button>
      </div>
    );
  }

  return (
    // h-dvh + internal scroll: globals.css disables body scroll app-wide, so a
    // min-h-screen root has no scroll container and everything below the fold
    // is unreachable (same bug class as app/login/page.tsx). The root IS the
    // scroll container so the sticky header sticks inside it.
    <div className="h-dvh overflow-y-auto bg-background">
      {/* Header */}
      <header className="border-b bg-card/80 sticky top-0 z-10 backdrop-blur-sm" style={{ paddingTop: 'env(safe-area-inset-top, 0px)' }}>
        <div className="max-w-4xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="size-8 rounded-xl bg-send flex items-center justify-center shadow-md flex-shrink-0">
            <Combine className="text-send-ink" style={{ width: 16, height: 16 }} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="font-bold text-sm truncate">{project.name}</h1>
            </div>
            <p className="text-xs text-muted-foreground">
              Shared folder by {project.ownerName} · {project.chats?.length || 0} conversations
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="flex-shrink-0 gap-1.5"
            onClick={() => window.open('/', '_blank')}
          >
            <ExternalLink className="size-3.5" />
            <span className="hidden sm:inline">Try Digby</span>
          </Button>
        </div>
      </header>

      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        {/* Project description */}
        {project.description && (
          <p className="text-sm text-muted-foreground leading-relaxed">{project.description}</p>
        )}

        {/* Conversations */}
        <div>
          <h2 className="text-sm font-semibold mb-3 flex items-center gap-2">
            <MessageSquare className="size-4 text-brand-accent" />
            Conversations ({project.chats?.length || 0})
          </h2>
          {!project.chats?.length ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No conversations yet.</p>
          ) : (
            <div className="space-y-2">
              {project.chats.map((chat: any) => (
                <div
                  key={chat.id}
                  className="flex items-center gap-3 rounded-xl border p-3 hover:bg-muted/30 transition-colors"
                >
                  <MessageSquare className="size-4 text-muted-foreground flex-shrink-0" />
                  <div className="flex-1 min-w-0">
                    <p className="font-medium text-sm truncate">{chat.title}</p>
                    <p className="text-xs text-muted-foreground">
                      {chat.messages?.length || 0} messages · {absoluteDate(chat.updatedAt)}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-xs capitalize flex-shrink-0">{chat.mode}</Badge>
                </div>
              ))}
            </div>
          )}
        </div>

        <Separator />

        {/* CTA */}
        <div className="text-center py-6">
          <div className="size-12 rounded-2xl bg-send flex items-center justify-center shadow-lg mx-auto mb-4">
            <Combine className="text-send-ink" style={{ width: 24, height: 24 }} />
          </div>
          <h3 className="font-bold text-lg mb-1">Try Digby for free</h3>
          <p className="text-sm text-muted-foreground mb-4">
            Ask any question — get answers from OpenAI, Grok, and Gemini, blended into one.
          </p>
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
